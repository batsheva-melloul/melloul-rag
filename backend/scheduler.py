"""
Nightly SharePoint sync, run from inside the web app.

Every night at SYNC_SCHEDULE (default 03:00, SYNC_TZ default Asia/Jerusalem) the
app pulls new / changed documents from SharePoint for every corpus, exactly like
the "sync now" button on the admin page, so nobody has to remember to press it.

The app runs as several gunicorn workers and each one starts this scheduler, so
the run is *claimed* through the database first (HistoryStore.claim_scheduled_sync)
and only the worker that wins the claim does the work. A manual sync that is
already running (in any worker) is waited for, up to an hour.

Requirements in production: "Always On" must be enabled on the App Service,
otherwise the process is stopped when nobody is using the site and the night
run never happens. Set SYNC_SCHEDULE=off to disable.
"""

import os
import time
import logging
import threading
from datetime import datetime, timedelta, time as dtime, timezone

logger = logging.getLogger("rag.scheduler")

DEFAULT_TIME = "03:00"
DEFAULT_TZ = "Asia/Jerusalem"
TRIGGER = "schedule"
# How long a scheduled run waits for a manual sync to finish before giving up.
WAIT_FOR_MANUAL_S = 60 * 60
POLL_S = 60


def _load_tz(name: str):
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception as error:  # missing tzdata, unknown name
        logger.warning("time zone %r unavailable (%s); using UTC", name, error)
        return timezone.utc


def parse_schedule() -> dict | None:
    """
    Read SYNC_SCHEDULE / SYNC_TZ. Returns {"time": datetime.time, "tz", "tzName",
    "label": "HH:MM"} or None when the schedule is off / invalid.
    """
    raw = (os.getenv("SYNC_SCHEDULE") or DEFAULT_TIME).strip().lower()
    if raw in ("off", "none", "false", "0", ""):
        return None
    try:
        hour, minute = raw.split(":")
        at = dtime(int(hour), int(minute))
    except ValueError:
        logger.error("SYNC_SCHEDULE=%r is not HH:MM; scheduled sync disabled", raw)
        return None
    tz_name = os.getenv("SYNC_TZ") or DEFAULT_TZ
    return {"time": at, "tz": _load_tz(tz_name), "tzName": tz_name,
            "label": f"{at.hour:02d}:{at.minute:02d}"}


def next_run_at(cfg: dict, now: datetime | None = None) -> datetime:
    """The next occurrence of the scheduled time, strictly after `now`."""
    now = (now or datetime.now(cfg["tz"])).astimezone(cfg["tz"])
    candidate = datetime.combine(now.date(), cfg["time"], tzinfo=cfg["tz"])
    if candidate <= now:
        candidate = datetime.combine(now.date() + timedelta(days=1), cfg["time"],
                                     tzinfo=cfg["tz"])
    return candidate


class SyncScheduler:
    """
    history    : HistoryStore (claim + "is a sync running anywhere?")
    corpora    : callable returning the list of corpus dicts
    run_corpus : callable(corpus, trigger_by) that performs + records one sync
    lock       : the process-wide "one sync at a time" lock shared with /admin/sync
    """

    def __init__(self, history, corpora, run_corpus, lock: threading.Lock,
                 cfg: dict | None = None):
        self.history = history
        self.corpora = corpora
        self.run_corpus = run_corpus
        self.lock = lock
        self.cfg = cfg if cfg is not None else parse_schedule()
        self._next: datetime | None = None
        self._thread: threading.Thread | None = None

    @property
    def enabled(self) -> bool:
        return self.cfg is not None

    def start(self) -> None:
        if not self.enabled:
            logger.info("scheduled sync: off")
            return
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, name="sync-scheduler", daemon=True)
        self._thread.start()
        logger.info("scheduled sync: every day at %s (%s)", self.cfg["label"], self.cfg["tzName"])

    def status(self) -> dict:
        """What the admin page shows: when the next run is due."""
        if not self.enabled:
            return {"enabled": False}
        nxt = self._next or next_run_at(self.cfg)
        return {"enabled": True, "time": self.cfg["label"], "tz": self.cfg["tzName"],
                "nextRunAt": int(nxt.timestamp() * 1000)}

    # ------------------------------------------------------------------ loop

    def _loop(self) -> None:
        while True:
            slot = next_run_at(self.cfg)
            self._next = slot
            # Sleep in short steps so a clock/DST change cannot make us oversleep.
            while True:
                remaining = (slot - datetime.now(self.cfg["tz"])).total_seconds()
                if remaining <= 0:
                    break
                time.sleep(min(POLL_S, max(1, remaining)))
            try:
                self.run_slot(slot)
            except Exception:
                logger.exception("scheduled sync failed")

    def run_slot(self, slot: datetime) -> bool:
        """Run the sync for one scheduled slot. Returns False when another
        worker already claimed it (or a manual sync never finished)."""
        slot_ms = int(slot.timestamp() * 1000)
        if not self.history.claim_scheduled_sync(slot_ms):
            logger.info("scheduled sync %s: claimed by another worker", slot.isoformat())
            return False

        deadline = time.time() + WAIT_FOR_MANUAL_S
        while self.history.running_sync() is not None:
            if time.time() > deadline:
                logger.warning("scheduled sync skipped: a manual sync is still running")
                return False
            time.sleep(POLL_S)

        with self.lock:
            logger.info("scheduled sync starting")
            for corpus in self.corpora():
                try:
                    summary = self.run_corpus(corpus, TRIGGER)
                    logger.info("scheduled sync %s: %s", corpus["id"], summary)
                except Exception:
                    logger.exception("scheduled sync failed for %s", corpus["id"])
            logger.info("scheduled sync done")
        return True
