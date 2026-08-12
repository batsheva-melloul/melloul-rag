"""
Vector store abstraction — two interchangeable backends behind one small interface.

- ChromaStore   — local persistent Chroma. Used for local dev, the CLI, and as the
                  SOURCE when migrating existing vectors into Postgres.
- PgVectorStore — Postgres + pgvector (cloud / production). The index lives IN the
                  database, not in the app's RAM, so a tiny app instance is enough
                  (this is what fixes the out-of-memory crash on the small plan).

rag_core talks ONLY to this interface, so switching backends is a single env var:

    VECTOR_STORE = chroma | pgvector        (default: chroma)

Each store instance is scoped to ONE corpus (like a Chroma collection). The scope
`name` already encodes the embedding model + chunk settings (see
rag_core.collection_name), so changing the model keeps vectors cleanly separate.

PgVectorStore config (env):
    DATABASE_URL = postgresql://user:pass@host:5432/dbname?sslmode=require
"""

import os
import logging

import numpy as np

logger = logging.getLogger("rag.store")


def _as_vector(embedding):
    """
    Coerce an embedding to a float32 numpy array so pgvector's psycopg adapter
    sends it as a `vector` (a plain Python list would be sent as float8[], which
    the `<=>` operator and vector column reject).
    """
    return np.asarray(embedding, dtype=np.float32)


def _vec_out(value):
    """Coerce a value read back from a pgvector column into a numpy array (the
    driver may hand back a pgvector Vector object), so the MMR reranker can use it."""
    if hasattr(value, "to_numpy"):
        return value.to_numpy()
    if hasattr(value, "to_list"):
        return np.asarray(value.to_list(), dtype=np.float32)
    return np.asarray(value, dtype=np.float32)

# Embedding dimension of our provider's model (text-embedding-3-small = 1536).
# The pgvector column is fixed to this size.
EMBED_DIM = 1536


# ---------------------------------------------------------------------------
# Chroma backend (local)
# ---------------------------------------------------------------------------

class ChromaStore:
    """Local Chroma-backed store for one corpus (one collection)."""

    def __init__(self, name: str):
        import chromadb
        chroma_dir = os.getenv("CHROMA_DIR", "chroma_db")
        self._client = chromadb.PersistentClient(path=chroma_dir)
        self._col = self._client.get_or_create_collection(name=name)

    def source_version(self, source: str) -> str | None:
        got = self._col.get(where={"source": source}, limit=1)
        if got["ids"]:
            return got["metadatas"][0].get("version")
        return None

    def delete_source(self, source: str) -> None:
        self._col.delete(where={"source": source})

    def add(self, ids, embeddings, documents, metadatas) -> None:
        self._col.add(ids=ids, embeddings=embeddings,
                      documents=documents, metadatas=metadatas)

    def semantic(self, embedding, n: int) -> list[dict]:
        r = self._col.query(
            query_embeddings=[embedding], n_results=n,
            include=["documents", "metadatas", "embeddings"],
        )
        return [
            {"id": cid, "text": doc, "source": meta["source"],
             "page_number": meta["page_number"], "embedding": emb}
            for cid, doc, meta, emb in zip(
                r["ids"][0], r["documents"][0], r["metadatas"][0], r["embeddings"][0]
            )
        ]

    def keyword(self, term: str, limit: int) -> list[dict]:
        r = self._col.get(
            where_document={"$contains": term}, limit=limit,
            include=["documents", "metadatas", "embeddings"],
        )
        return [
            {"id": cid, "text": doc, "source": meta["source"],
             "page_number": meta["page_number"], "embedding": emb}
            for cid, doc, meta, emb in zip(
                r["ids"], r["documents"], r["metadatas"], r["embeddings"]
            )
        ]

    def count(self) -> int:
        return self._col.count()

    def sources(self, page: int = 5000) -> list[str]:
        """Distinct source filenames in this corpus (cached, paginated)."""
        if not hasattr(self, "_sources_cache"):
            seen, offset = set(), 0
            while True:
                got = self._col.get(include=["metadatas"], limit=page, offset=offset)
                metas = got["metadatas"]
                if not metas:
                    break
                seen.update(m["source"] for m in metas)
                offset += len(metas)
                if len(metas) < page:
                    break
            self._sources_cache = sorted(seen)
        return self._sources_cache

    def semantic_in_source(self, embedding, source: str, n: int) -> list[dict]:
        """Top-n chunks BY VECTOR SIMILARITY restricted to one source document."""
        r = self._col.query(
            query_embeddings=[embedding], n_results=n,
            where={"source": source},
            include=["documents", "metadatas", "embeddings"],
        )
        return [
            {"id": cid, "text": doc, "source": meta["source"],
             "page_number": meta["page_number"], "embedding": emb}
            for cid, doc, meta, emb in zip(
                r["ids"][0], r["documents"][0], r["metadatas"][0], r["embeddings"][0]
            )
        ]

    def iter_all(self, page: int = 5000):
        """
        Yield every stored chunk (with its embedding) — used by the migration.
        Paginated so a huge collection isn't loaded into memory all at once.
        """
        offset = 0
        while True:
            got = self._col.get(
                include=["documents", "metadatas", "embeddings"],
                limit=page, offset=offset,
            )
            batch_ids = got["ids"]
            if not batch_ids:
                break
            for cid, doc, meta, emb in zip(
                batch_ids, got["documents"], got["metadatas"], got["embeddings"]
            ):
                yield {
                    "id": cid, "text": doc, "source": meta["source"],
                    "page_number": meta["page_number"],
                    "version": meta.get("version", ""), "embedding": emb,
                }
            offset += len(batch_ids)
            if len(batch_ids) < page:
                break


# ---------------------------------------------------------------------------
# Postgres + pgvector backend (cloud)
# ---------------------------------------------------------------------------

class PgVectorStore:
    """
    Postgres/pgvector store. A single shared table `chunks` holds every corpus;
    rows are scoped by the `corpus_id` column (set to this store's `name`).
    """

    def __init__(self, name: str):
        self.corpus_id = name
        self._dsn = os.environ.get("DATABASE_URL")
        if not self._dsn:
            raise RuntimeError(
                "VECTOR_STORE=pgvector requires DATABASE_URL in the environment."
            )
        self._conn = None
        self._ensure_schema()

    # --- connection handling (Azure closes idle connections, so reconnect) ---

    def _connect(self) -> None:
        import psycopg
        from pgvector.psycopg import register_vector
        self._conn = psycopg.connect(self._dsn, autocommit=True)
        register_vector(self._conn)
        # With an IVFFlat index, `probes` sets how many lists a search scans.
        # The default (1) gives poor recall; too many is slow on the small
        # Burstable Postgres. 5 balances recall against latency (~0.5s server-side
        # vs ~9s at 20). Harmless if the index is ever HNSW (setting is unused).
        with self._conn.cursor() as cur:
            cur.execute("SET ivfflat.probes = 5")

    def _run(self, sql: str, params=None, fetch: str | None = None, many: bool = False):
        """Execute a statement, reconnecting once if the connection has dropped."""
        import psycopg
        for attempt in (1, 2):
            try:
                if self._conn is None or self._conn.closed:
                    self._connect()
                with self._conn.cursor() as cur:
                    if many:
                        cur.executemany(sql, params)
                        return None
                    cur.execute(sql, params)
                    if fetch == "one":
                        return cur.fetchone()
                    if fetch == "all":
                        return cur.fetchall()
                    return None
            except psycopg.OperationalError:
                self._conn = None            # force a fresh connection next attempt
                if attempt == 2:
                    raise

    def _ensure_schema(self) -> None:
        """Create the table + supporting indexes if they don't exist (idempotent)."""
        self._run("CREATE EXTENSION IF NOT EXISTS vector")
        self._run("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        self._run(
            f"""CREATE TABLE IF NOT EXISTS chunks (
                    corpus_id   text    NOT NULL,
                    chunk_id    text    NOT NULL,
                    source      text    NOT NULL,
                    page_number int,
                    version     text,
                    text        text,
                    embedding   vector({EMBED_DIM}),
                    PRIMARY KEY (corpus_id, chunk_id)
                )"""
        )
        # Fast source lookups (version check / delete-by-source).
        self._run("CREATE INDEX IF NOT EXISTS chunks_source "
                  "ON chunks (corpus_id, source)")
        # Trigram index makes the keyword ILIKE search fast.
        self._run("CREATE INDEX IF NOT EXISTS chunks_trgm "
                  "ON chunks USING gin (text gin_trgm_ops)")
        # NOTE: the HNSW vector index is built by the migration script AFTER the
        # bulk load (building it on an empty table then inserting is much slower).

    # --- interface used by rag_core ---

    def source_version(self, source: str) -> str | None:
        row = self._run(
            "SELECT version FROM chunks WHERE corpus_id=%s AND source=%s LIMIT 1",
            (self.corpus_id, source), fetch="one",
        )
        return row[0] if row else None

    def delete_source(self, source: str) -> None:
        self._run("DELETE FROM chunks WHERE corpus_id=%s AND source=%s",
                  (self.corpus_id, source))

    def add(self, ids, embeddings, documents, metadatas) -> None:
        rows = [
            (self.corpus_id, cid, m["source"], m["page_number"],
             m.get("version", ""), doc, _as_vector(emb))
            for cid, emb, doc, m in zip(ids, embeddings, documents, metadatas)
        ]
        self._run(
            "INSERT INTO chunks "
            "(corpus_id, chunk_id, source, page_number, version, text, embedding) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (corpus_id, chunk_id) DO UPDATE SET "
            "source=EXCLUDED.source, page_number=EXCLUDED.page_number, "
            "version=EXCLUDED.version, text=EXCLUDED.text, embedding=EXCLUDED.embedding",
            rows, many=True,
        )

    def semantic(self, embedding, n: int) -> list[dict]:
        rows = self._run(
            "SELECT chunk_id, text, source, page_number, embedding FROM chunks "
            "WHERE corpus_id=%s ORDER BY embedding <=> %s LIMIT %s",
            (self.corpus_id, _as_vector(embedding), n), fetch="all",
        )
        return [
            {"id": r[0], "text": r[1], "source": r[2],
             "page_number": r[3], "embedding": _vec_out(r[4])}
            for r in rows
        ]

    def keyword(self, term: str, limit: int) -> list[dict]:
        rows = self._run(
            "SELECT chunk_id, text, source, page_number, embedding FROM chunks "
            "WHERE corpus_id=%s AND text ILIKE %s LIMIT %s",
            (self.corpus_id, f"%{term}%", limit), fetch="all",
        )
        return [
            {"id": r[0], "text": r[1], "source": r[2],
             "page_number": r[3], "embedding": _vec_out(r[4])}
            for r in rows
        ]

    def count(self) -> int:
        row = self._run("SELECT count(*) FROM chunks WHERE corpus_id=%s",
                        (self.corpus_id,), fetch="one")
        return row[0] if row else 0

    def sources(self) -> list[str]:
        """Distinct source filenames in this corpus (cached)."""
        if not hasattr(self, "_sources_cache"):
            rows = self._run("SELECT DISTINCT source FROM chunks WHERE corpus_id=%s",
                             (self.corpus_id,), fetch="all")
            self._sources_cache = sorted(r[0] for r in rows)
        return self._sources_cache

    def semantic_in_source(self, embedding, source: str, n: int) -> list[dict]:
        """Top-n chunks BY VECTOR SIMILARITY restricted to one source document."""
        rows = self._run(
            "SELECT chunk_id, text, source, page_number, embedding FROM chunks "
            "WHERE corpus_id=%s AND source=%s ORDER BY embedding <=> %s LIMIT %s",
            (self.corpus_id, source, _as_vector(embedding), n), fetch="all",
        )
        return [
            {"id": r[0], "text": r[1], "source": r[2],
             "page_number": r[3], "embedding": _vec_out(r[4])}
            for r in rows
        ]


# ---------------------------------------------------------------------------
# Factory — pick the backend from the VECTOR_STORE env var
# ---------------------------------------------------------------------------

def make_store(name: str):
    """Return a store for one corpus, chosen by VECTOR_STORE (default: chroma)."""
    backend = os.getenv("VECTOR_STORE", "chroma").lower()
    if backend == "pgvector":
        return PgVectorStore(name)
    if backend == "chroma":
        return ChromaStore(name)
    raise ValueError(f"Unknown VECTOR_STORE '{backend}'. Use 'chroma' or 'pgvector'.")
