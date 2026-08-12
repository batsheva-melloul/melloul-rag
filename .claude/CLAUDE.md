# Company RAG Chatbot

Internal Q&A chatbot that answers employee questions based **only** on the content of
company documents (strict grounding), cites its sources, and clearly says when an answer
is not in the documents. Architecture: RAG (retrieval-augmented generation).

## Tech stack

- **Language:** Python (all RAG logic)
- **LLM + embeddings:** Google Gemini (free tier) — `google-genai` SDK
  - Chat model: `gemini-2.5-flash`
  - Embedding model: `gemini-embedding-001`
- **Vector store:** Chroma (local, persistent in `chroma_db/`)
- **Backend:** FastAPI (`backend/`)
- **Frontend:** React with **plain JavaScript** (Vite). NOT TypeScript, NOT Next.js. (`frontend/`)

## Project layout

```
RAG/
├── llm.py             # LLM provider abstraction — ONLY file that imports a vendor SDK
├── rag_core.py        # Core RAG logic (PDF → chunks → embeddings → Chroma → answer)
├── rag_pipeline.py    # Command-line interface (interactive Q&A loop)
├── backend/
│   ├── main.py        # FastAPI server exposing the /ask endpoint
│   └── auth.py        # Entra JWT validation (Depends(verify_token))
├── frontend/          # React (plain JS) chat UI, with MSAL sign-in
├── docs/              # Local PDF documents (input)
├── chroma_db/         # Persisted vector store (auto-generated, git-ignored)
├── requirements.txt   # Python dependencies
└── .env               # GEMINI_API_KEY (git-ignored, never commit)
```

## Switching LLM provider

All model/embedding calls go through `llm.py` — no other file imports a vendor SDK.
To change provider, add a `Provider` class there and set the `LLM_PROVIDER` env var
(default `gemini`). The embedding model name is part of the Chroma collection name, so
changing the embedding model triggers a clean re-index.

## Setup

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Create a `.env` file with:
```
GEMINI_API_KEY=your_key_here
```

## Running

**CLI (quickest test):**
```powershell
python rag_pipeline.py docs\<file>.pdf
```

**Full web app (two terminals):**
```powershell
# Terminal 1 — backend
uvicorn backend.main:app --port 8000 --reload

# Terminal 2 — frontend
cd frontend
npm run dev          # opens http://localhost:5173
```

## Important conventions

- **Code & comments:** English. **Explanations to the user:** Hebrew.
- **Secrets** live in environment variables, never in code.
- **Grounding is mandatory:** the model must answer only from retrieved excerpts. If no
  context is retrieved, the code returns "no info" WITHOUT calling the model (so it can
  never answer from outside knowledge).

## Environment notes (important gotchas)

- **Corporate SSL inspection:** every HTTPS call fails with `CERTIFICATE_VERIFY_FAILED`
  unless SSL verification is disabled. `rag_core.py` monkeypatches `httpx.Client` to set
  `verify=False` BEFORE importing google-genai. Do not remove this on this network.
- **Gemini free-tier limits:** embeddings are rate-limited (~100/min) and have a daily
  cap. The code batches embeddings (100/request) and retries on 429/503. A document is
  embedded only once — Chroma caches it by a content hash, so re-runs make no API calls.
- **OCR:** `pypdf` only reads a real text layer. Scanned/image-only PDFs yield 0 text and
  are rejected. Use PDFs that already contain extractable text.

## Build phases

1. ✅ Local MVP (single script, in-memory) — done
2. ✅ Real vector store (Chroma) — done
3. ⬜ Pull documents from SharePoint via Microsoft Graph
4. ✅ React chat UI + FastAPI backend — done
5. ⬜ Entra ID SSO (internal only)
6. ⬜ Cloud deployment