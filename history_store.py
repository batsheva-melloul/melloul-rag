"""
Server-side storage for everything that is NOT document chunks:

  - conversations  : each user's chat history (one JSON document per conversation,
                     exactly the shape the React app keeps in localStorage), so a
                     user sees the same conversations on every device/browser.
  - question_log   : one row per question answered by /ask or /ask/stream
                     (who, which corpus, answered / "no info" / error, latency).
                     This is what the admin page reports on.
  - sync_runs      : one row per SharePoint sync (started/finished, counts,
                     status), whether started from the CLI, the admin page or
                     the nightly scheduler.
  - sync_schedule  : which nightly slot was last claimed (one row), so that only
                     one of the web workers runs the scheduled sync.

Backend: Postgres when DATABASE_URL is set (the same database pgvector uses),
otherwise a local SQLite file (HISTORY_DB, default data/history.db) so the app
also works on a laptop without database access. Both share the same SQL,
written with `?` placeholders; they are rewritten to `%s` for Postgres.
"""

import os
import json
import time
import logging
import threading

logger = logging.getLogger("rag.history")

# A running sync proves its process is alive by updating heartbeat_at (see
# sharepoint.sync_corpus_recorded). A run whose heartbeat is older than this
# belongs to a process that died (deploy / restart / crash) and is closed out.
STALE_SYNC_MS = 5 * 60 * 1000


def now_ms() -> int:
    return int(time.time() * 1000)


class HistoryStore:
    def __init__(self):
        self._dsn = os.environ.get("DATABASE_URL")
        self._lock = threading.Lock()
        self._conn = None
        if self._dsn:
            self.backend = "postgres"
        else:
            self.backend = "sqlite"
            self._path = os.environ.get("HISTORY_DB") or os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "data", "history.db")
            os.makedirs(os.path.dirname(self._path), exist_ok=True)
        self._ensure_schema()
        logger.info("History store ready (%s)", self.backend)

    # ------------------------------------------------------------------ core

    def _connect(self):
        if self.backend == "postgres":
            import psycopg
            self._conn = psycopg.connect(self._dsn, autocommit=True)
        else:
            import sqlite3
            self._conn = sqlite3.connect(self._path, check_same_thread=False,
                                         isolation_level=None)  # autocommit

    def _sql(self, sql: str) -> str:
        return sql.replace("?", "%s") if self.backend == "postgres" else sql

    def _run(self, sql: str, params=(), fetch: str | None = None):
        """Execute one statement under the store lock, reconnecting once if the
        connection dropped (Azure closes idle Postgres connections)."""
        with self._lock:
            for attempt in (1, 2):
                try:
                    if self._conn is None or getattr(self._conn, "closed", False):
                        self._connect()
                    cur = self._conn.cursor()
                    try:
                        cur.execute(self._sql(sql), params)
                        if fetch == "one":
                            return cur.fetchone()
                        if fetch == "all":
                            return cur.fetchall()
                        if fetch == "rowcount":
                            return cur.rowcount
                        return None
                    finally:
                        cur.close()
                except Exception as error:
                    if self.backend == "postgres":
                        import psycopg
                        if isinstance(error, psycopg.OperationalError) and attempt == 1:
                            self._conn = None
                            continue
                    raise

    def _ensure_schema(self) -> None:
        serial = "BIGSERIAL PRIMARY KEY" if self.backend == "postgres" else \
                 "INTEGER PRIMARY KEY AUTOINCREMENT"
        bool_t = "boolean" if self.backend == "postgres" else "integer"
        self._run(f"""CREATE TABLE IF NOT EXISTS conversations (
                        id          text PRIMARY KEY,
                        user_id     text NOT NULL,
                        corpus_id   text NOT NULL,
                        title       text,
                        messages    text NOT NULL,
                        updated_at  bigint NOT NULL
                      )""")
        self._run("CREATE INDEX IF NOT EXISTS conversations_user "
                  "ON conversations (user_id, updated_at)")
        self._run(f"""CREATE TABLE IF NOT EXISTS question_log (
                        id          {serial},
                        ts          bigint NOT NULL,
                        user_id     text,
                        user_name   text,
                        corpus_id   text,
                        question    text,
                        status      text,          -- answered | no_info | error
                        sources     integer,
                        whole_book  {bool_t},
                        latency_ms  integer
                      )""")
        self._run("CREATE INDEX IF NOT EXISTS question_log_ts ON question_log (ts)")
        self._run(f"""CREATE TABLE IF NOT EXISTS sync_runs (
                        id          {serial},
                        corpus_id   text NOT NULL,
                        trigger_by  text,          -- cli | admin:<user> | schedule
                        started_at  bigint NOT NULL,
                        finished_at bigint,
                        heartbeat_at bigint,       -- last "still alive" tick of a running sync
                        status      text NOT NULL, -- running | ok | error
                        total       integer,
                        indexed     integer,
                        skipped     integer,
                        error       text
                      )""")
        self._run("CREATE INDEX IF NOT EXISTS sync_runs_corpus "
                  "ON sync_runs (corpus_id, started_at)")
        # Databases created before heartbeat_at existed: add the column. SQLite has
        # no "ADD COLUMN IF NOT EXISTS", so a duplicate-column error means it is there.
        try:
            self._run("ALTER TABLE sync_runs ADD COLUMN heartbeat_at bigint")
        except Exception:
            pass
        # One row per schedule: which slot (scheduled time, epoch ms) was last
        # claimed. Lets several web workers agree on who runs the nightly sync.
        self._run("""CREATE TABLE IF NOT EXISTS sync_schedule (
                        key        text PRIMARY KEY,
                        last_slot  bigint
                      )""")

    # --------------------------------------------------------- conversations

    @staticmethod
    def _row_to_conversation(row) -> dict:
        cid, corpus_id, title, messages, updated_at = row
        return {
            "id": cid,
            "corpusId": corpus_id,
            "title": title or "",
            "messages": json.loads(messages) if messages else [],
            "updatedAt": updated_at,
        }

    def list_conversations(self, user_id: str, corpus_id: str | None = None) -> list[dict]:
        if corpus_id:
            rows = self._run("SELECT id, corpus_id, title, messages, updated_at "
                             "FROM conversations WHERE user_id = ? AND corpus_id = ? "
                             "ORDER BY updated_at DESC", (user_id, corpus_id), fetch="all")
        else:
            rows = self._run("SELECT id, corpus_id, title, messages, updated_at "
                             "FROM conversations WHERE user_id = ? "
                             "ORDER BY updated_at DESC", (user_id,), fetch="all")
        return [self._row_to_conversation(r) for r in rows or []]

    def upsert_conversation(self, user_id: str, doc: dict) -> bool:
        """Insert or update one conversation. Returns False if the id belongs
        to a different user (the caller should answer 403)."""
        owner = self._run("SELECT user_id FROM conversations WHERE id = ?",
                          (doc["id"],), fetch="one")
        if owner and owner[0] != user_id:
            return False
        params = (doc["id"], user_id, doc["corpusId"], doc.get("title") or "",
                  json.dumps(doc.get("messages") or [], ensure_ascii=False),
                  int(doc.get("updatedAt") or now_ms()))
        if self.backend == "postgres":
            self._run("""INSERT INTO conversations (id, user_id, corpus_id, title, messages, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?)
                         ON CONFLICT (id) DO UPDATE SET
                           corpus_id = EXCLUDED.corpus_id, title = EXCLUDED.title,
                           messages = EXCLUDED.messages, updated_at = EXCLUDED.updated_at""",
                      params)
        else:
            self._run("INSERT OR REPLACE INTO conversations "
                      "(id, user_id, corpus_id, title, messages, updated_at) "
                      "VALUES (?, ?, ?, ?, ?, ?)", params)
        return True

    def delete_conversation(self, user_id: str, conversation_id: str) -> None:
        self._run("DELETE FROM conversations WHERE id = ? AND user_id = ?",
                  (conversation_id, user_id))

    # ---------------------------------------------------------- question log

    def log_question(self, *, user_id: str, user_name: str, corpus_id: str,
                     question: str, status: str, sources: int,
                     whole_book: bool, latency_ms: int) -> None:
        try:
            self._run("INSERT INTO question_log (ts, user_id, user_name, corpus_id, question, "
                      "status, sources, whole_book, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                      (now_ms(), user_id, user_name, corpus_id, question[:2000], status,
                       int(sources), bool(whole_book), int(latency_ms)))
        except Exception:
            # Logging must never break answering.
            logger.exception("question_log insert failed")

    def recent_questions(self, limit: int = 50, corpus_id: str | None = None,
                         status: str | None = None) -> list[dict]:
        where, params = [], []
        if corpus_id:
            where.append("corpus_id = ?"); params.append(corpus_id)
        if status:
            where.append("status = ?"); params.append(status)
        sql = ("SELECT ts, user_name, corpus_id, question, status, sources, whole_book, latency_ms "
               "FROM question_log" + (" WHERE " + " AND ".join(where) if where else "") +
               " ORDER BY ts DESC LIMIT ?")
        params.append(int(limit))
        rows = self._run(sql, tuple(params), fetch="all") or []
        return [{"ts": r[0], "user": r[1], "corpusId": r[2], "question": r[3],
                 "status": r[4], "sources": r[5], "wholeBook": bool(r[6]),
                 "latencyMs": r[7]} for r in rows]

    def usage_stats(self, days: int = 7) -> dict:
        """Totals for the last `days` days, overall and per corpus."""
        since = now_ms() - days * 86400 * 1000
        rows = self._run(
            "SELECT corpus_id, status, COUNT(*), AVG(latency_ms), COUNT(DISTINCT user_id) "
            "FROM question_log WHERE ts >= ? GROUP BY corpus_id, status",
            (since,), fetch="all") or []
        total = {"questions": 0, "no_info": 0, "errors": 0, "avg_latency_ms": 0}
        per_corpus: dict[str, dict] = {}
        weighted = 0.0
        for corpus_id, status, count, avg_latency, _users in rows:
            c = per_corpus.setdefault(corpus_id, {"questions": 0, "no_info": 0, "errors": 0})
            c["questions"] += count
            total["questions"] += count
            if status == "no_info":
                c["no_info"] += count; total["no_info"] += count
            elif status == "error":
                c["errors"] += count; total["errors"] += count
            weighted += float(avg_latency or 0) * count
        if total["questions"]:
            total["avg_latency_ms"] = int(weighted / total["questions"])
        users = self._run("SELECT COUNT(DISTINCT user_id) FROM question_log WHERE ts >= ?",
                          (since,), fetch="one")
        total["active_users"] = int(users[0]) if users else 0
        return {"days": days, "total": total, "per_corpus": per_corpus}

    # -------------------------------------------------------------- storage

    def storage_stats(self) -> dict:
        """
        How much space the database uses, and how it splits between document
        chunks, conversations and the question log (bytes; None = unknown).
        Postgres reports real on-disk sizes including indexes. SQLite (local
        dev) reports the file size and the raw length of the stored JSON.
        """
        count = self._run("SELECT COUNT(*) FROM conversations", fetch="one")
        stats = {"backend": self.backend, "conversations": int(count[0]) if count else 0,
                 "dbBytes": None, "chunksBytes": None,
                 "conversationsBytes": None, "questionLogBytes": None}
        if self.backend == "postgres":
            row = self._run(
                "SELECT pg_database_size(current_database()), "
                "pg_total_relation_size('conversations'), "
                "pg_total_relation_size('question_log'), "
                "CASE WHEN to_regclass('chunks') IS NULL THEN NULL "
                "     ELSE pg_total_relation_size('chunks') END", fetch="one")
            stats.update(dbBytes=row[0], conversationsBytes=row[1],
                         questionLogBytes=row[2], chunksBytes=row[3])
        else:
            try:
                stats["dbBytes"] = os.path.getsize(self._path)
            except OSError:
                pass
            row = self._run("SELECT COALESCE(SUM(LENGTH(messages)), 0) FROM conversations",
                            fetch="one")
            stats["conversationsBytes"] = int(row[0]) if row else 0
        return stats

    # ------------------------------------------------------------ sync runs

    def start_sync_run(self, corpus_id: str, trigger_by: str) -> int:
        now = now_ms()
        if self.backend == "postgres":
            row = self._run("INSERT INTO sync_runs (corpus_id, trigger_by, started_at, heartbeat_at, status) "
                            "VALUES (?, ?, ?, ?, 'running') RETURNING id",
                            (corpus_id, trigger_by, now, now), fetch="one")
            return int(row[0])
        self._run("INSERT INTO sync_runs (corpus_id, trigger_by, started_at, heartbeat_at, status) "
                  "VALUES (?, ?, ?, ?, 'running')", (corpus_id, trigger_by, now, now))
        row = self._run("SELECT last_insert_rowid()", fetch="one")
        return int(row[0])

    def heartbeat_sync_run(self, run_id: int) -> None:
        """Called every minute while a sync runs: proves its process is still alive,
        so another worker's startup never mistakes it for a dead run."""
        try:
            self._run("UPDATE sync_runs SET heartbeat_at = ? WHERE id = ? AND status = 'running'",
                      (now_ms(), run_id))
        except Exception:
            logger.exception("sync heartbeat failed")

    def finish_sync_run(self, run_id: int, *, status: str, total: int = 0,
                        indexed: int = 0, skipped: int = 0, error: str | None = None) -> None:
        self._run("UPDATE sync_runs SET finished_at = ?, status = ?, total = ?, indexed = ?, "
                  "skipped = ?, error = ? WHERE id = ?",
                  (now_ms(), status, total, indexed, skipped, (error or "")[:1000] or None, run_id))

    def last_sync_runs(self) -> dict[str, dict]:
        """The most recent run per corpus, keyed by corpus id."""
        self.abandon_running_syncs()  # a dead run must not show as "running" forever
        rows = self._run("SELECT corpus_id, trigger_by, started_at, finished_at, status, total, "
                         "indexed, skipped, error FROM sync_runs ORDER BY started_at DESC",
                         fetch="all") or []
        out: dict[str, dict] = {}
        for r in rows:
            if r[0] in out:
                continue
            out[r[0]] = {"corpusId": r[0], "triggerBy": r[1], "startedAt": r[2],
                         "finishedAt": r[3], "status": r[4], "total": r[5],
                         "indexed": r[6], "skipped": r[7], "error": r[8]}
        return out

    def running_sync(self) -> dict | None:
        self.abandon_running_syncs()  # ignore runs whose process has died
        r = self._run("SELECT id, corpus_id, trigger_by, started_at FROM sync_runs "
                      "WHERE status = 'running' ORDER BY started_at DESC LIMIT 1", fetch="one")
        if not r:
            return None
        return {"id": r[0], "corpusId": r[1], "triggerBy": r[2], "startedAt": r[3]}

    def claim_scheduled_sync(self, slot_ms: int, key: str = "nightly") -> bool:
        """
        Atomically claim the scheduled run for `slot_ms`. Every worker calls this
        at the scheduled time; exactly one gets True (the UPDATE only matches
        while the stored slot is older), the others skip the run.
        """
        if self.backend == "postgres":
            self._run("INSERT INTO sync_schedule (key, last_slot) VALUES (?, NULL) "
                      "ON CONFLICT DO NOTHING", (key,))
        else:
            self._run("INSERT OR IGNORE INTO sync_schedule (key, last_slot) VALUES (?, NULL)",
                      (key,))
        changed = self._run("UPDATE sync_schedule SET last_slot = ? "
                            "WHERE key = ? AND (last_slot IS NULL OR last_slot < ?)",
                            (slot_ms, key, slot_ms), fetch="rowcount")
        return bool(changed)

    def abandon_running_syncs(self) -> None:
        """
        Close out runs still marked 'running' whose heartbeat has stopped: their
        process died (deploy / restart / crash). A sync that is alive in ANOTHER
        worker keeps heartbeating and is left alone — so this is safe to call at
        every worker's startup and before every status read.
        """
        now = now_ms()
        self._run("UPDATE sync_runs SET status = 'error', finished_at = ?, "
                  "error = 'interrupted (process stopped)' "
                  "WHERE status = 'running' AND COALESCE(heartbeat_at, started_at) < ?",
                  (now, now - STALE_SYNC_MS))
