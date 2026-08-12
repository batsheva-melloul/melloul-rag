"""
One-time migration: copy existing vectors from local Chroma into Postgres/pgvector.

For each corpus it reads every chunk from the local Chroma collection — WITH its
already-computed embedding — and bulk-inserts it into the pgvector `chunks` table.
No re-embedding, so it makes ZERO embedding-API calls and costs nothing.

After loading, it builds the HNSW vector index (falling back to IVFFlat if the
small Postgres instance can't build HNSW), which makes semantic search fast.

Safe to re-run: inserts upsert by primary key, and fully-migrated corpora are
skipped — so if the network drops mid-run, just run it again.

Prerequisite: DATABASE_URL must point at the Azure Postgres, e.g.
    postgresql://ragadmin:PASS@melloul-rag-pg.postgres.database.azure.com:5432/ragdb?sslmode=require

Run locally (reads the local chroma_db on this machine):
    python migrate_to_pgvector.py
"""

import os
import logging

from dotenv import load_dotenv

import rag_core  # applies the sqlite shim and exposes collection_name()
from vectorstore import ChromaStore, PgVectorStore
from corpora import all_corpora
from llm import get_provider
from log_config import setup_logging

BATCH = 500  # rows per INSERT round-trip


def migrate():
    setup_logging()
    load_dotenv()
    log = logging.getLogger("rag.migrate")

    if not os.getenv("DATABASE_URL"):
        raise SystemExit(
            "DATABASE_URL is not set. Put the Azure Postgres connection string in "
            ".env (or the environment) and re-run."
        )

    embed_model = get_provider().embed_model  # no API call — just reads config

    for corpus in all_corpora():
        name = rag_core.collection_name(corpus["id"], embed_model)
        src = ChromaStore(name)
        total = src.count()
        log.info("=== Corpus '%s' (%s): %d chunks in Chroma ===",
                 corpus["id"], corpus["name"], total)
        if total == 0:
            continue

        dst = PgVectorStore(name)
        if dst.count() >= total:
            log.info("  already migrated (%d in Postgres) — skipping", dst.count())
            continue

        ids, embs, docs, metas, done = [], [], [], [], 0

        def flush():
            nonlocal ids, embs, docs, metas, done
            if not ids:
                return
            dst.add(ids=ids, embeddings=embs, documents=docs, metadatas=metas)
            done += len(ids)
            log.info("  %s: %d/%d rows", corpus["id"], done, total)
            ids, embs, docs, metas = [], [], [], []

        for row in src.iter_all():
            ids.append(row["id"])
            embs.append(row["embedding"])
            docs.append(row["text"])
            metas.append({"source": row["source"],
                          "page_number": row["page_number"],
                          "version": row["version"]})
            if len(ids) >= BATCH:
                flush()
        flush()
        log.info("Corpus '%s' done: %d rows now in Postgres", corpus["id"], dst.count())

    _build_vector_index(log, embed_model)
    log.info("Migration complete.")


def _build_vector_index(log, embed_model):
    """Build the approximate-nearest-neighbour index once, after the bulk load."""
    # Any store instance gives us a connection to the shared `chunks` table.
    pg = PgVectorStore(rag_core.collection_name(all_corpora()[0]["id"], embed_model))

    # Give the index build a bit more memory if the server allows it (ignored/capped
    # on tiny instances — harmless).
    try:
        pg._run("SET maintenance_work_mem = '512MB'")
    except Exception:
        pass

    # NOTE: HNSW is impractical to build on the Burstable B1ms Postgres — the graph
    # doesn't fit in the small RAM, so the build becomes disk-bound and takes hours.
    # IVFFlat builds in minutes and, with ivfflat.probes raised at query time (see
    # PgVectorStore._connect), gives good recall. So build IVFFlat directly.
    log.info("Building IVFFlat vector index...")
    pg._run("CREATE INDEX IF NOT EXISTS chunks_ivf ON chunks "
            "USING ivfflat (embedding vector_cosine_ops) WITH (lists = 300)")
    log.info("IVFFlat index ready.")

    # Update planner statistics after the bulk load so the keyword (trgm) index is
    # actually used instead of a sequential scan.
    log.info("Updating table statistics (ANALYZE)...")
    pg._run("ANALYZE chunks")
    log.info("Statistics updated.")


if __name__ == "__main__":
    migrate()
