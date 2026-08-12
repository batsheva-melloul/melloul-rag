# Backend — FastAPI

Thin HTTP layer over the RAG logic in `../rag_core.py`. It does not contain RAG logic
itself — it imports `RagEngine` and exposes it over HTTP.

## Files

- `main.py` — the FastAPI app, request/response models, and the `/ask` endpoint.

## How it works

1. On startup, `main.py` creates one `RagEngine(PDF_PATH)`. This builds (or loads from
   Chroma) the vector index for the configured PDF — so it happens **once**, not per request.
2. The frontend POSTs to `/ask` with `{ "question": "..." }`.
3. The endpoint returns `{ "answer": "...", "sources": [{ "page_number": int, "text": str }] }`.

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