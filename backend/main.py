"""
FastAPI backend for the RAG chatbot.

Endpoints:
    GET  /corpora  - list the chatbots/corpora the signed-in user may access
    POST /ask      - answer a question from a chosen corpus

Each corpus is a separate document repository, configured in corpora.py, with its
own isolated Chroma collection. Access is gated by Entra App Roles (see auth.py).

Run from the project root with:
    uvicorn backend.main:app --reload
"""

import os
import sys
import time
import logging

# Allow importing rag_core.py from the project root (one level up from /backend).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from log_config import setup_logging
from rag_core import build_registry
from backend.auth import verify_token, has_corpus_access, DEMO_MODE
from corpora import all_corpora, get_corpus

setup_logging()
logger = logging.getLogger("rag.api")

# Default corpus used when a request doesn't specify one (older frontend).
DEFAULT_CORPUS_ID = all_corpora()[0]["id"]

# Internal app — disable the public API docs/schema (/docs, /redoc, /openapi.json)
# so the endpoint structure isn't exposed to internet scanners.
app = FastAPI(
    title="Company RAG Chatbot",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Log every API request: method, path, status, and how long it took."""
    start = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - start) * 1000
    logger.info(
        "%s %s -> %s (%.0f ms)",
        request.method, request.url.path, response.status_code, elapsed_ms,
    )
    return response

# Allow the React dev server (running on a different port) to call this API.
# In demo mode, accept the Vite dev server from any host (localhost or LAN IP);
# otherwise only localhost.
if DEMO_MODE:
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"http://[^/]+:5173",
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

# Build one engine per corpus at startup (each has its own isolated collection).
engines = build_registry()
logger.info(
    "Backend ready. DEMO_MODE=%s. Corpora: %s",
    DEMO_MODE, [c["id"] for c in all_corpora()],
)


# --- Request/response shapes ---

class HistoryMessage(BaseModel):
    """One prior turn in the conversation."""
    role: str   # "user" or "bot"
    text: str


class AskRequest(BaseModel):
    """Incoming question from the frontend, plus the conversation so far."""
    question: str
    history: list[HistoryMessage] = []
    # Which chatbot/corpus to answer from. Defaults to the first corpus
    # so an older frontend (not yet sending it) keeps working.
    corpus_id: str = DEFAULT_CORPUS_ID
    # Optional formatting instruction from a template button (e.g. make flashcards).
    # It shapes the answer but is kept out of retrieval (search uses the question).
    directive: str = ""


class Corpus(BaseModel):
    """A chatbot/corpus exposed to the UI."""
    id: str
    name: str


class Source(BaseModel):
    """A single document excerpt the answer is based on."""
    source: str
    page_number: int
    text: str


class AskResponse(BaseModel):
    """The answer plus the sources it came from."""
    answer: str
    sources: list[Source]


@app.get("/corpora", response_model=list[Corpus])
def list_corpora(user: dict = Depends(verify_token)) -> list[Corpus]:
    """Return only the chatbots/corpora this user is allowed to access."""
    return [
        Corpus(id=c["id"], name=c["name"])
        for c in all_corpora()
        if has_corpus_access(user, c)
    ]


@app.post("/ask", response_model=AskResponse)
def ask(request: AskRequest, user: dict = Depends(verify_token)) -> AskResponse:
    """
    Answer a question from the requested corpus, using the conversation history.
    Protected: requires a valid Entra token AND access to the requested corpus.
    """
    who = user.get("upn") or user.get("preferred_username") or "demo-user"

    corpus = get_corpus(request.corpus_id)
    if corpus is None:
        logger.warning("ask: unknown corpus '%s' (user=%s)", request.corpus_id, who)
        raise HTTPException(status_code=404, detail=f"Unknown corpus: {request.corpus_id}")
    if not has_corpus_access(user, corpus):
        logger.warning("ask: FORBIDDEN corpus '%s' for user=%s", request.corpus_id, who)
        raise HTTPException(status_code=403, detail="You do not have access to this corpus.")

    logger.info("ask: user=%s corpus=%s q=%r", who, request.corpus_id, request.question[:80])
    engine = engines[request.corpus_id]
    history = [{"role": m.role, "text": m.text} for m in request.history]
    try:
        result = engine.answer(request.question, history, directive=request.directive)
    except Exception:
        # Don't leak internal errors to the client; log them and return a
        # friendly message the chat UI can display.
        logger.exception("ask: failed (user=%s corpus=%s)", who, request.corpus_id)
        return AskResponse(
            answer="מצטער, הייתה תקלה זמנית בעיבוד השאלה. נסו שוב בעוד רגע.",
            sources=[],
        )
    logger.info("ask: answered (sources=%d)", len(result["sources"]))
    return AskResponse(answer=result["answer"], sources=result["sources"])


# ---------------------------------------------------------------------------
# Serve the built React frontend (single-service deployment)
# ---------------------------------------------------------------------------
# In production we bundle the Vite build (frontend/dist) and serve it from
# FastAPI, so the whole app is ONE service — the page and the API share an
# origin (no CORS, one URL to deploy). This mount is LAST so the API routes
# above take precedence. Skipped when there's no build (local dev, where the
# frontend runs on the Vite dev server instead).
_FRONTEND_DIST = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend", "dist"
)
if os.path.isdir(_FRONTEND_DIST):
    app.mount("/", StaticFiles(directory=_FRONTEND_DIST, html=True), name="frontend")
    logger.info("Serving frontend build from %s", _FRONTEND_DIST)
else:
    logger.info("No frontend build at %s — running API-only (dev mode)", _FRONTEND_DIST)