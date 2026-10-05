# Backend — FastAPI

Thin HTTP layer over the RAG logic in `../rag_core.py`. It does not contain RAG logic
itself — it imports `RagEngine` and exposes it over HTTP.

## Files

- `main.py` — the FastAPI app, request/response models, `/ask` + `/ask/stream`,
  `/me`, `/conversations` (server-side history) and the `/admin/*` endpoints.
- `auth.py` — Entra JWT validation + per-corpus App Role check.
- `../history_store.py` — conversations, question log and sync runs (Postgres via
  `DATABASE_URL`, else SQLite at `data/history.db` / `HISTORY_DB`).

## How it works

1. On startup, `main.py` creates one `RagEngine(PDF_PATH)`. This builds (or loads from
   Chroma) the vector index for the configured PDF — so it happens **once**, not per request.
2. The frontend POSTs to `/ask` with `{ "question": "..." }`.
3. The endpoint returns `{ "answer": "...", "sources": [{ "page_number": int, "text": str }] }`.
4. `POST /ask/stream` is the streaming twin the chat UI actually uses: same request,
   same checks and grounding, but the reply is written while the model is still
   answering, as Server-Sent Events: `data: {"type":"delta","text":...}` lines,
   then one `data: {"type":"done","sources":[...],"whole_book":bool}` (or
   `{"type":"error",...}`). It MUST stay `text/event-stream`: Azure App Service's
   front end holds any other chunked response until it completes (verified with
   `GET /health/stream?fmt=ndjson|sse|text`, a no-auth diagnostic kept for this).
   It calls `RagEngine.answer_stream`, which shares `_prepare` (rewrite + retrieval +
   prompt) with `answer`, so the two can never differ in what they ground on.
   `/ask` stays for the CLI/eval and as a fallback.

## Server-side history & admin page

- **History:** the React app stores each conversation as one JSON document via
  `PUT /conversations/{id}` (client-generated ids) and loads them with
  `GET /conversations`. Ownership is by the token's `oid` (falls back to email); a
  PUT on someone else's id is 403. The shape is the UI's own (`id, corpusId, title,
  messages, updatedAt`) so the client needs no translation.
- **Question log:** every `/ask` and `/ask/stream` call writes one row
  (`answered | no_info | error`, sources, latency). `no_info` = the "אין לי מידע"
  message or zero sources. Logging never raises.
- **Admin:** `is_admin(user)` = the `admin` App Role in the token OR the email is in
  the `ADMIN_USERS` env var (comma-separated). DEMO_MODE makes everyone admin.
  `GET /admin/overview` (per-corpus docs/chunks/last sync + usage totals),
  `GET /admin/questions`, `GET /admin/sync/status`, `POST /admin/sync?corpus_id=`
  (runs `sharepoint.sync_corpus_recorded` in a background thread with this process's
  engine; one at a time; `sync_runs` rows make "last sync" visible, also for CLI runs).
  The overview also reports database storage (`history.storage_stats()`: total,
  chunks, conversations, question log). Set `DB_STORAGE_GB` (the size allocated to
  the Postgres server) to show "used of total" with a meter; SQL cannot see the quota.
  **To make someone an admin in production:** add their email to `ADMIN_USERS` in the
  App Service settings (or assign the `admin` App Role in Entra).

## Configuration

- `PDF_PATH` environment variable selects which PDF to serve (default: `docs/aaa.pdf`).
- CORS is open to `http://localhost:5173` (the Vite dev server). Update this for production.

## Running

From the **project root** (not from inside `backend/`):
```powershell
uvicorn backend.main:app --port 8000 --reload
```

`--reload` restarts on code changes. NOTE: changing `PDF_PATH` or the indexed document
still requires a restart, because the index is built at startup.

## Conventions

- Keep this layer thin: validation + serialization only. All retrieval/LLM logic stays in
  `rag_core.py` so the CLI and the API share exactly one implementation.
- Request/response shapes are defined with Pydantic models (`AskRequest`, `AskResponse`).