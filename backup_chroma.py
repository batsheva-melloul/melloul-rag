"""
Periodic, crash-safe snapshots of the local Chroma store during a long sync.

WHY: a corrupted local index must never cost hours of embedding work again. This
takes a file-level COPY of chroma_db every few minutes, validates the COPY
(opens ONLY the copy, read-only), and keeps the last few good snapshots.

SAFETY: it NEVER queries the LIVE collection — it only copies files and inspects
the copy. That is categorically different from what corrupted the index before
(concurrent queries on the live store), so this cannot cause that failure.

Restore, if the live index ever breaks:
    1. stop the sync
    2. delete chroma_db
    3. copy the newest good_* snapshot back to chroma_db
    4. run the sync again — it resumes from there

Config via env vars (all optional):
    CHROMA_DIR            source store           (default: chroma_db)
    BACKUP_ROOT           where snapshots go     (default: C:\\Users\\batshevar\\chroma_backups)
    BACKUP_INTERVAL_MIN   minutes between snaps  (default: 20)
    BACKUP_KEEP           how many to keep       (default: 2)
"""

import os
import sys
import time
import shutil
import logging
import subprocess

SRC = os.getenv("CHROMA_DIR", "chroma_db")
DEST_ROOT = os.getenv("BACKUP_ROOT", r"C:\Users\batshevar\chroma_backups")
INTERVAL = int(os.getenv("BACKUP_INTERVAL_MIN", "20")) * 60
KEEP = int(os.getenv("BACKUP_KEEP", "2"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("backup")


_VALIDATOR = (
    "import chromadb, sys;"
    "c = chromadb.PersistentClient(path=sys.argv[1]);"
    "print(sum(x.count() for x in c.list_collections()))"
)


def validate(path: str) -> int:
    """
    Count every collection in the COPY (never the live store) by opening it in a
    SEPARATE process. Why a subprocess: chromadb keeps the store's files open,
    and Windows won't let us rename a folder with open handles — when the child
    process exits, all handles are released cleanly. A torn/half-written copy
    makes the child exit non-zero; a good copy prints the chunk total.
    """
    out = subprocess.run(
        [sys.executable, "-c", _VALIDATOR, path],
        capture_output=True, text=True, timeout=600,
    )
    if out.returncode != 0:
        raise RuntimeError((out.stderr or "").strip()[-300:] or "validator failed")
    return int(out.stdout.strip())


def rotate():
    """Keep only the newest KEEP good snapshots; delete older ones."""
    snaps = sorted(d for d in os.listdir(DEST_ROOT) if d.startswith("good_"))
    while len(snaps) > KEEP:
        victim = snaps.pop(0)
        shutil.rmtree(os.path.join(DEST_ROOT, victim), ignore_errors=True)
        log.info("removed old snapshot %s", victim)


def main():
    os.makedirs(DEST_ROOT, exist_ok=True)
    log.info("Backup watcher started. src=%s dest=%s every=%dmin keep=%d",
             SRC, DEST_ROOT, INTERVAL // 60, KEEP)
    while True:
        # Snapshot first (so the very first restore point is created right away),
        # then wait for the next cycle.
        if os.path.isdir(SRC):
            snapshot_once()
        else:
            log.info("no %s yet — skipping this cycle", SRC)
        time.sleep(INTERVAL)


def snapshot_once():
    stamp = time.strftime("%Y%m%d_%H%M%S")
    pending = os.path.join(DEST_ROOT, f"good_{stamp}_pending")
    shutil.rmtree(pending, ignore_errors=True)

    # 1) Copy the folder. If a file is momentarily locked, skip this cycle.
    try:
        shutil.copytree(SRC, pending)
    except Exception as error:
        log.warning("copy failed (%s) — will retry next cycle", error)
        shutil.rmtree(pending, ignore_errors=True)
        return

    # 2) Validate the COPY in a subprocess (never the live store).
    try:
        count = validate(pending)
    except Exception as error:
        log.warning("snapshot invalid (%s) — discarding, keeping previous good one",
                    error)
        shutil.rmtree(pending, ignore_errors=True)
        return

    # 3) Promote to a good_ snapshot (subprocess has exited -> no open handles),
    #    then prune old ones.
    good = os.path.join(DEST_ROOT, f"good_{stamp}_{count}chunks")
    os.rename(pending, good)
    log.info("snapshot OK -> %s  (%d chunks total)", os.path.basename(good), count)
    rotate()


if __name__ == "__main__":
    main()
