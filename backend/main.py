"""
FastAPI backend for the RAG chatbot.

Endpoints:
    GET  /corpora     - list the chatbots/corpora the signed-in user may access
    POST /ask         - answer a question from a chosen corpus (one JSON reply)
    POST /ask/stream  - same, but streams the answer as Server-Sent Events while
                        the model writes (the chat UI uses this one)
    GET  /me          - the signed-in user's name/email and whether they are an admin
    GET/PUT/DELETE /conversations[/{id}] - the user's chat history, stored server-side
    GET  /admin/overview, /admin/questions, /admin/sync/status, POST /admin/sync
                      - admin page (ADMIN_USERS env or the "admin" App Role)

Each corpus is a separate document repository, configured in corpora.py, with its
own isolated Chroma collection. Access is gated by Entra App Roles (see auth.py).

Run from the project root with:
    uvicorn backend.main:app --reload
"""

import os
import sys
import asyncio
import threading
import json
import time
import logging

# Allow importing rag_core.py from the project root (one level up from /backend).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI, Depends, HTTPException, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from log_config import setup_logging
from rag_core import build_registry, NO_INFO_MESSAGE
from history_store import HistoryStore
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

# Conversations, question log and sync runs (Postgres when DATABASE_URL is set,
# else a local SQLite file). A sync marked "running" by a process that died in a
# restart is closed out so the admin page is never stuck.
history = HistoryStore()
history.abandon_running_syncs()

# Who may open the admin page: anyone whose token carries the "admin" App Role,
# or whose email is listed in ADMIN_USERS (comma-separated, case-insensitive).
ADMIN_ROLE = "admin"
# Optional: the storage size allocated to the Postgres server, in GB. SQL cannot
# see the Azure quota, so set this to let the admin page show "used of total".
DB_STORAGE_GB = float(os.getenv("DB_STORAGE_GB", "0") or 0)
ADMIN_USERS = {u.strip().lower() for u in os.getenv("ADMIN_USERS", "").split(",") if u.strip()}


def user_email(user: dict) -> str:
    return (user.get("upn") or user.get("preferred_username") or user.get("email") or "").lower()


def user_id(user: dict) -> str:
    """Stable per-user key for stored data: Entra object id, else the email."""
    return user.get("oid") or user_email(user) or "demo-user"


def user_display(user: dict) -> str:
    return user.get("name") or user_email(user) or "demo-user"


def is_admin(user: dict) -> bool:
    if DEMO_MODE:
        return True
    if ADMIN_ROLE in (user.get("roles") or []):
        return True
    return user_email(user) in ADMIN_USERS


def require_admin(user: dict = Depends(verify_token)) -> dict:
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Admins only.")
    return user
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
    # Template requests set this: if the question names a book, read the whole book
    # (a wide sample) instead of only the top matches.
    comprehensive: bool = False
    # Optional book scope from the UI's book-picker: exact source filenames.
    # When non-empty, retrieval is confined to those book(s).
    books: list[str] = []


class ConversationDoc(BaseModel):
    """
    One conversation exactly as the React app keeps it (so the client can store
    and restore it without translation). `messages` is free-form JSON: the UI
    owns its message shape (role/text/sources/books/template...).
    """
    id: str
    corpusId: str
    title: str = ""
    messages: list[dict] = []
    updatedAt: int = 0


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
    # True when the answer used whole-book mode (read a wide sample of one book) —
    # lets the UI note that it's based on more passages than the few shown.
    whole_book: bool = False


@app.get("/me")
def me(user: dict = Depends(verify_token)) -> dict:
    """Who is signed in, and whether the admin page should be offered."""
    return {"name": user_display(user), "email": user_email(user), "isAdmin": is_admin(user)}


@app.get("/conversations", response_model=list[ConversationDoc])
def list_conversations(corpus_id: str | None = None,
                       user: dict = Depends(verify_token)) -> list[dict]:
    """This user's saved conversations (optionally only one corpus's)."""
    return history.list_conversations(user_id(user), corpus_id)


@app.put("/conversations/{conversation_id}")
def save_conversation(conversation_id: str, doc: ConversationDoc,
                      user: dict = Depends(verify_token)) -> dict:
    """Create or update one conversation. Ids are client-generated."""
    if doc.id != conversation_id:
        raise HTTPException(status_code=400, detail="id mismatch")
    if get_corpus(doc.corpusId) is None:
        raise HTTPException(status_code=404, detail=f"Unknown corpus: {doc.corpusId}")
    if not history.upsert_conversation(user_id(user), doc.model_dump()):
        raise HTTPException(status_code=403, detail="Not your conversation.")
    return {"ok": True}


@app.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str, user: dict = Depends(verify_token)) -> dict:
    history.delete_conversation(user_id(user), conversation_id)
    return {"ok": True}


@app.get("/corpora", response_model=list[Corpus])
def list_corpora(user: dict = Depends(verify_token)) -> list[Corpus]:
    """Return only the chatbots/corpora this user is allowed to access."""
    return [
        Corpus(id=c["id"], name=c["name"])
        for c in all_corpora()
        if has_corpus_access(user, c)
    ]


@app.get("/books", response_model=list[str])
def list_books(corpus_id: str = DEFAULT_CORPUS_ID,
               user: dict = Depends(verify_token)) -> list[str]:
    """
    Return the book (source) filenames in a corpus, for the UI's book-picker.
    Protected the same way as /ask: valid token AND access to the corpus.
    """
    corpus = get_corpus(corpus_id)
    if corpus is None:
        raise HTTPException(status_code=404, detail=f"Unknown corpus: {corpus_id}")
    if not has_corpus_access(user, corpus):
        raise HTTPException(status_code=403, detail="You do not have access to this corpus.")
    return sorted(engines[corpus_id].store.sources())


ASK_FAILED_MESSAGE = "מצטער, הייתה תקלה זמנית בעיבוד השאלה. נסו שוב בעוד רגע."


def log_question(user: dict, request: "AskRequest", started: float, *,
                 answer: str = "", sources: int = 0, whole_book: bool = False,
                 error: bool = False) -> None:
    """One row per question for the admin page. Never raises."""
    if error:
        status = "error"
    elif answer.strip() == NO_INFO_MESSAGE.strip() or sources == 0:
        status = "no_info"
    else:
        status = "answered"
    history.log_question(
        user_id=user_id(user), user_name=user_display(user), corpus_id=request.corpus_id,
        question=request.question, status=status, sources=sources, whole_book=whole_book,
        latency_ms=int((time.perf_counter() - started) * 1000),
    )


def _authorize_ask(request: AskRequest, user: dict) -> str:
    """
    Shared checks for /ask and /ask/stream: the corpus exists and the user may
    access it. Returns the user's display id for logging. Raises 404/403.
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
    return who


@app.post("/ask", response_model=AskResponse)
def ask(request: AskRequest, user: dict = Depends(verify_token)) -> AskResponse:
    """
    Answer a question from the requested corpus, using the conversation history.
    Protected: requires a valid Entra token AND access to the requested corpus.
    """
    who = _authorize_ask(request, user)
    engine = engines[request.corpus_id]
    turns = [{"role": m.role, "text": m.text} for m in request.history]
    started = time.perf_counter()
    try:
        result = engine.answer(request.question, turns, directive=request.directive,
                               comprehensive=request.comprehensive, books=request.books)
    except Exception:
        # Don't leak internal errors to the client; log them and return a
        # friendly message the chat UI can display.
        logger.exception("ask: failed (user=%s corpus=%s)", who, request.corpus_id)
        log_question(user, request, started, error=True)
        return AskResponse(answer=ASK_FAILED_MESSAGE, sources=[])
    logger.info("ask: answered (sources=%d)", len(result["sources"]))
    log_question(user, request, started, answer=result["answer"],
                 sources=len(result["sources"]), whole_book=result.get("whole_book", False))
    return AskResponse(
        answer=result["answer"],
        sources=result["sources"],
        whole_book=result.get("whole_book", False),
    )


@app.get("/health/stream")
async def health_stream(n: int = 5, gap: float = 0.6, pad: int = 0,
                        fmt: str = "ndjson", mode: str = "sync") -> StreamingResponse:
    """
    Diagnostic: `n` short lines, `gap` seconds apart, with NO auth and NO model
    call. If a client receives them spread over time the hosting layer passes
    streamed responses through; if they all arrive together something in
    between is buffering. Knobs for finding out WHAT the hosting layer lets
    through: `pad` (bytes of filler in the first line, for size-based buffers),
    `fmt` (ndjson | sse | text: some proxies only stream text/event-stream),
    `mode` (sync generator in a thread vs. async generator).
    """
    n = max(1, min(n, 50))
    gap = max(0.0, min(gap, 5.0))
    pad = max(0, min(pad, 256 * 1024))

    def line(i: int) -> str:
        body = json.dumps({"tick": i, "t": round(time.time(), 3)})
        return f"data: {body}\n\n" if fmt == "sse" else body + "\n"

    def sync_ticks():
        if pad:
            yield (" " * pad) + "\n"
        for i in range(n):
            yield line(i)
            time.sleep(gap)

    async def async_ticks():
        if pad:
            yield (" " * pad) + "\n"
        for i in range(n):
            yield line(i)
            await asyncio.sleep(gap)

    media = {"sse": "text/event-stream", "text": "text/plain; charset=utf-8"}.get(
        fmt, "application/x-ndjson")
    return StreamingResponse(
        async_ticks() if mode == "async" else sync_ticks(),
        media_type=media,
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/ask/stream")
def ask_stream(request: AskRequest, user: dict = Depends(verify_token)) -> StreamingResponse:
    """
    Streaming twin of /ask. Same checks, same grounding, but the reply is written
    while the model is still answering, as Server-Sent Events (one `data:` line
    per event, blank line between events):
        {"type": "delta", "text": "..."}                        one piece of the answer
        {"type": "done", "sources": [...], "whole_book": bool}  always the last event
        {"type": "error", "message": "..."}                     if something broke mid-way
    The UI appends deltas to the bubble as they arrive, then attaches the sources.

    WHY SSE and not plain NDJSON: Azure App Service's front end holds a chunked
    response until it is complete UNLESS the content type is text/event-stream
    (measured with /health/stream: ndjson and text/plain arrive all at once even
    with 256 KB of padding; text/event-stream arrives progressively).
    """
    who = _authorize_ask(request, user)
    engine = engines[request.corpus_id]
    turns = [{"role": m.role, "text": m.text} for m in request.history]
    started = time.perf_counter()

    def sse(event: dict) -> str:
        # json.dumps never emits raw newlines, so one event is always one line.
        return "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"

    def events():
        count, whole_book, answer = 0, False, []
        try:
            for event in engine.answer_stream(
                request.question, turns, directive=request.directive,
                comprehensive=request.comprehensive, books=request.books,
            ):
                if event["type"] == "delta":
                    answer.append(event["text"])
                elif event["type"] == "done":
                    count = len(event["sources"])
                    whole_book = event.get("whole_book", False)
                yield sse(event)
            logger.info("ask/stream: answered (sources=%d)", count)
            log_question(user, request, started, answer="".join(answer),
                         sources=count, whole_book=whole_book)
        except Exception:
            # Headers are already sent, so we cannot change the status code;
            # report the failure as a final event the UI knows how to show.
            logger.exception("ask/stream: failed (user=%s corpus=%s)", who, request.corpus_id)
            log_question(user, request, started, error=True)
            yield sse({"type": "error", "message": ASK_FAILED_MESSAGE})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            # Ask proxies (Azure front end / nginx) not to buffer the stream.
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Admin page: usage, corpora health, question log, SharePoint sync on demand
# ---------------------------------------------------------------------------

# Only one sync at a time in this process (it downloads + embeds documents).
_sync_lock = threading.Lock()


@app.get("/admin/overview")
def admin_overview(days: int = Query(7, ge=1, le=365),
                   user: dict = Depends(require_admin)) -> dict:
    """Everything the admin page shows at a glance."""
    last_runs = history.last_sync_runs()
    corpora = []
    for c in all_corpora():
        store = engines[c["id"]].store
        try:
            docs, chunks = len(store.sources()), store.count()
        except Exception:
            logger.exception("admin: store stats failed for %s", c["id"])
            docs, chunks = None, None
        corpora.append({
            "id": c["id"], "name": c["name"], "role": c.get("role"),
            "sitePath": c.get("site_path"), "folder": c.get("folder"),
            "docs": docs, "chunks": chunks, "lastSync": last_runs.get(c["id"]),
        })
    try:
        storage = history.storage_stats()
    except Exception:
        logger.exception("admin: storage stats failed")
        storage = None
    if storage is not None:
        storage["allocatedBytes"] = int(DB_STORAGE_GB * 1024 ** 3) if DB_STORAGE_GB else None
    return {
        "corpora": corpora,
        "usage": history.usage_stats(days),
        "runningSync": history.running_sync(),
        "historyBackend": history.backend,
        "storage": storage,
    }


@app.get("/admin/questions")
def admin_questions(limit: int = Query(50, ge=1, le=500), corpus_id: str | None = None,
                    status: str | None = Query(None, pattern="^(answered|no_info|error)$"),
                    user: dict = Depends(require_admin)) -> list[dict]:
    """Most recent questions (optionally one corpus / one status)."""
    return history.recent_questions(limit=limit, corpus_id=corpus_id, status=status)


@app.get("/admin/sync/status")
def admin_sync_status(user: dict = Depends(require_admin)) -> dict:
    return {"running": history.running_sync(), "last": history.last_sync_runs()}


@app.post("/admin/sync")
def admin_sync(corpus_id: str, user: dict = Depends(require_admin)) -> dict:
    """
    Start a SharePoint sync for one corpus in a background thread and return
    immediately; the page polls /admin/sync/status. Uses this process's engine,
    so new documents are searchable the moment they are indexed.
    """
    corpus = get_corpus(corpus_id)
    if corpus is None:
        raise HTTPException(status_code=404, detail=f"Unknown corpus: {corpus_id}")
    if not _sync_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="A sync is already running.")

    who = user_display(user)
    import sharepoint  # imported lazily: needs the Graph env vars only when used

    def run():
        try:
            hostname = os.environ["SHAREPOINT_HOSTNAME"]
            sharepoint.sync_corpus_recorded(hostname, corpus, engines[corpus_id],
                                            history, f"admin:{who}")
        except Exception:
            logger.exception("admin sync failed for %s", corpus_id)
        finally:
            _sync_lock.release()

    threading.Thread(target=run, name=f"sync-{corpus_id}", daemon=True).start()
    logger.info("admin: sync started for %s by %s", corpus_id, who)
    return {"started": True, "corpusId": corpus_id}


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