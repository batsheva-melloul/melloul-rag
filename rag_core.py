"""
RAG core logic — shared by the CLI (rag_pipeline.py) and the FastAPI backend.

This module knows how to: read a PDF, chunk it, embed chunks via Gemini,
store/query them in Chroma, and answer a question grounded in the documents.
"""

# --- SQLite shim for Chroma ---
# Chroma requires sqlite3 >= 3.35, but some Linux hosts (e.g. Azure App Service)
# ship an older system sqlite3. When the modern bundled build (pysqlite3-binary)
# is installed, swap it in BEFORE importing chromadb. On Windows/local it isn't
# installed and the stdlib sqlite3 is new enough, so we skip silently.
try:
    __import__("pysqlite3")
    import sys as _sys
    _sys.modules["sqlite3"] = _sys.modules.pop("pysqlite3")
except ImportError:
    pass

import os
import io
import re
import logging
import hashlib

import numpy as np
from dotenv import load_dotenv
from pypdf import PdfReader

logger = logging.getLogger("rag.core")

# All LLM/embedding calls go through this provider abstraction (llm.py),
# so this file never imports a vendor SDK directly. The SSL patch lives there too.
from llm import get_provider

# The vector store lives behind an abstraction (vectorstore.py) with two backends:
# local Chroma (dev) and Postgres/pgvector (cloud). Chosen by the VECTOR_STORE env
# var. This file never touches a specific store's API directly.
from vectorstore import make_store

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

RERANK_POOL = 30                            # candidate chunks pulled before reranking
FINAL_K = 10                                # chunks kept (sent to the model) after reranking
KEYWORD_EXTRA = 4                            # extra candidates added by keyword search (hybrid)
MMR_LAMBDA = 0.7                            # rerank: relevance vs. diversity balance (0..1)
MAX_HISTORY_MESSAGES = 10                    # how many recent turns to keep (cost control)
CHUNK_SIZE = 500                            # characters per chunk
CHUNK_OVERLAP = 100                         # overlap between consecutive chunks
EMBED_BATCH_SIZE = 100                      # texts per embedding API request
CHROMA_DIR = os.getenv("CHROMA_DIR", "chroma_db")   # where Chroma persists data; override in cloud (e.g. /home/data/chroma_db) so it survives redeploys

SYSTEM_PROMPT = (
    "You are a friendly company assistant. Reply in the same language the user writes in "
    "(usually Hebrew).\n\n"
    "RULES:\n"
    "1. Base every substantive answer ONLY on the document excerpts provided below. "
    "Never use outside knowledge or facts that are not present in — or reasonably "
    "derivable from — the excerpts.\n"
    "2. You may provide TWO kinds of content:\n"
    "   (a) Facts stated explicitly in the excerpts — present them directly.\n"
    "   (b) Reasoned inferences/analysis that logically follow from the excerpts, even if "
    "not written word-for-word — these ARE allowed and encouraged when helpful.\n"
    "3. Flag ONLY genuine inferences. A direct quote or a close paraphrase of what the "
    "text says is NOT an inference — present it plainly, do NOT label it. Only when you "
    "draw a NEW conclusion that the text does not state explicitly, you MUST:\n"
    "   - clearly flag it as your own conclusion (e.g. 'זוהי מסקנה שלי ולא כתובה כך "
    "במפורש במקור...'), AND\n"
    "   - explain HOW you reached it — which statements in the text led you to that "
    "conclusion.\n"
    "   Keep explicit facts and your inferences clearly distinguishable.\n"
    "4. If the question cannot be answered or reasonably inferred from the excerpts, say "
    "clearly that the information is not in the documents. Do not invent facts.\n"
    "5. Do NOT mention chunk numbers, page numbers, or source labels inside your answer "
    "text. The sources are shown to the user separately by the app.\n"
    "6. You MAY respond naturally to simple greetings, thanks, or small talk — briefly "
    "and politely — without inventing any facts about the company or the documents.\n"
    "7. If the user asks specifically about a NAMED document or book, and excerpts from "
    "that document are present below, base your answer PRIMARILY on those excerpts (the "
    "ones whose source label matches the named document) — not on other documents that "
    "merely discuss or mention it.\n"
)

# A clear message returned when nothing relevant is found in the documents.
NO_INFO_MESSAGE = "אין לי מידע על כך במסמכים."

# Used to turn a short follow-up ("ומה עם הספר הזה?") into a standalone search
# query, so retrieval doesn't rely on a context-less fragment. Only invoked when
# there is prior conversation.
REWRITE_SYSTEM_PROMPT = (
    "You rewrite the user's LATEST message into a single standalone search query for "
    "a document search engine, resolving pronouns and references (\"this book\", \"he\", "
    "\"that idea\") using the conversation so far.\n"
    "Rules:\n"
    "- Output ONLY the rewritten query text — no quotes, no explanation, no prefix.\n"
    "- Keep it in the SAME language as the user (usually Hebrew).\n"
    "- If the latest message is already self-contained, return it unchanged.\n"
    "- Keep it concise: a search query, not a sentence of prose."
)


# ---------------------------------------------------------------------------
# Step 1 — Extract text from PDF
# ---------------------------------------------------------------------------

def _pages_from_reader(reader: PdfReader) -> list[dict]:
    """Return a list of {page_number, text} dicts from an open PdfReader."""
    pages = []
    for i, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        if text.strip():
            pages.append({"page_number": i, "text": text})
    return pages


def extract_pages(pdf_path: str) -> list[dict]:
    """Extract pages from a PDF file on disk."""
    return _pages_from_reader(PdfReader(pdf_path))


def extract_pages_from_bytes(data: bytes) -> list[dict]:
    """Extract pages from PDF bytes held in memory (no file on disk)."""
    return _pages_from_reader(PdfReader(io.BytesIO(data)))


# ---------------------------------------------------------------------------
# Step 2 — Split text into overlapping chunks
# ---------------------------------------------------------------------------

# Split on sentence enders (Latin + Hebrew/CJK punctuation) or blank lines.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?。])\s+|\n+")


def _split_sentences(text: str) -> list[str]:
    """Break text into sentence-like segments (keeps words/sentences whole)."""
    return [part.strip() for part in _SENTENCE_SPLIT.split(text) if part.strip()]


def split_into_chunks(pages: list[dict], chunk_size: int, overlap: int, source: str) -> list[dict]:
    """
    Split each page into overlapping chunks at SENTENCE boundaries (not mid-word),
    which gives cleaner, more retrievable chunks. Each chunk carries its source
    filename, page number, and a sequential index.
    """
    chunks = []
    chunk_index = 0

    for page in pages:
        page_number = page["page_number"]

        def emit(text: str):
            nonlocal chunk_index
            text = text.strip()
            if text:
                chunks.append({
                    "chunk_index": chunk_index,
                    "source": source,
                    "page_number": page_number,
                    "text": text,
                })
                chunk_index += 1

        current: list[str] = []
        current_len = 0

        for sentence in _split_sentences(page["text"]):
            # A single sentence longer than a chunk: flush, then hard-split it.
            if len(sentence) > chunk_size:
                if current:
                    emit(" ".join(current))
                    current, current_len = [], 0
                for i in range(0, len(sentence), chunk_size):
                    emit(sentence[i:i + chunk_size])
                continue

            # Adding this sentence would overflow: emit current, keep an overlap tail.
            if current and current_len + len(sentence) + 1 > chunk_size:
                emit(" ".join(current))
                keep, keep_len = [], 0
                for s in reversed(current):
                    if keep_len + len(s) + 1 > overlap:
                        break
                    keep.insert(0, s)
                    keep_len += len(s) + 1
                current, current_len = keep, keep_len

            current.append(sentence)
            current_len += len(sentence) + 1

        if current:
            emit(" ".join(current))

    return chunks


# ---------------------------------------------------------------------------
# Step 3 — Embed text (delegated to the LLM provider)
# ---------------------------------------------------------------------------

def embed_text(text: str, llm) -> list[float]:
    """Return an embedding vector for a single text string (used for questions)."""
    return llm.embed([text])[0]


# ---------------------------------------------------------------------------
# Step 4 — Vector store (Chroma): build the index and query it
# ---------------------------------------------------------------------------

def collection_name(corpus_id: str, embed_model: str) -> str:
    """
    Each corpus gets its OWN collection — this is what isolates the chatbots.
    The name also encodes the chunking + embedding-model settings, so changing
    any of them starts a fresh collection (incompatible vectors otherwise).
    """
    settings = f"{CHUNK_SIZE}-{CHUNK_OVERLAP}-{embed_model}"
    digest = hashlib.md5(settings.encode()).hexdigest()
    return f"corpus_{corpus_id}_{digest}"


def file_hash(pdf_path: str) -> str:
    """Return an MD5 hash of the file's bytes — used to detect changed files."""
    with open(pdf_path, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def version_is_current(store, source: str, version: str) -> bool:
    """
    True if this source is already indexed with this exact version.
    "version" is any change-marker: a file hash (local) or a SharePoint cTag.
    Lets us skip a document WITHOUT downloading/reading it.
    """
    current = store.source_version(source)
    return current is not None and current == version


def index_pdf_bytes(store, llm, source: str, version: str, data: bytes) -> int:
    """
    Index a single PDF (given as in-memory bytes) into the shared collection.
    Replaces any previous chunks for the same source. Returns chunks added.
    The PDF bytes are never written to disk — only the resulting vectors persist.
    """
    pages = extract_pages_from_bytes(data)
    chunks = split_into_chunks(pages, CHUNK_SIZE, CHUNK_OVERLAP, source)

    # A scanned (non-OCR'd) PDF yields no text. Warn and skip it.
    if not chunks:
        logger.warning("[%s] no extractable text (not OCR'd?) — skipped", source)
        return 0

    # Embed EVERYTHING first. If this fails (network drop, quota, or the machine
    # is shut down mid-sync), the collection hasn't been touched yet — so the
    # source stays in its previous state and a re-run cleanly retries it. This
    # avoids leaving a book "half-indexed" (which would then be wrongly skipped).
    logger.info("[%s] embedding %d chunks...", source, len(chunks))
    ids, texts, metas, embeddings = [], [], [], []
    for start in range(0, len(chunks), EMBED_BATCH_SIZE):
        batch = chunks[start:start + EMBED_BATCH_SIZE]
        batch_texts = [c["text"] for c in batch]
        embeddings.extend(llm.embed(batch_texts))
        texts.extend(batch_texts)
        ids.extend(f"{source}-{c['chunk_index']}" for c in batch)  # globally unique
        metas.extend(
            {"source": source, "page_number": c["page_number"], "version": version}
            for c in batch
        )

    # All embeddings are ready — NOW replace this source's chunks (delete old,
    # add new, in local batches). This part is fast and offline.
    store.delete_source(source)
    for start in range(0, len(ids), EMBED_BATCH_SIZE):
        end = start + EMBED_BATCH_SIZE
        store.add(
            ids=ids[start:end],
            embeddings=embeddings[start:end],
            documents=texts[start:end],
            metadatas=metas[start:end],
        )
    return len(chunks)


def index_one_pdf(pdf_path: str, store, llm) -> int:
    """
    Index a single PDF from disk (the local docs/ flow).
    Skips files already indexed (same content); re-indexes changed files.
    """
    source = os.path.basename(pdf_path)
    version = file_hash(pdf_path)

    if version_is_current(store, source, version):
        logger.info("[%s] already indexed — skipping", source)
        return 0

    with open(pdf_path, "rb") as f:
        data = f.read()
    return index_pdf_bytes(store, llm, source, version, data)


# Hebrew/English words of 3+ letters; ignores digits and punctuation.
_WORD_RE = re.compile(r"[^\W\d_]{3,}", re.UNICODE)

# Very common words that shouldn't drive a keyword search.
_STOPWORDS = {
    "מה", "של", "על", "עם", "הוא", "היא", "את", "אם", "כי", "אבל", "או", "גם",
    "זה", "זאת", "יש", "אין", "איך", "למה", "כמה", "מי", "היה", "הם", "הן", "לא",
    "כן", "אשר", "אלא", "the", "and", "for", "that", "this", "with", "what", "how",
}


def _keywords(question: str, limit: int = 5) -> list[str]:
    """Pull the most specific terms from the question for the keyword search."""
    seen = []
    for word in _WORD_RE.findall(question):
        if word.lower() in _STOPWORDS or word in seen:
            continue
        seen.append(word)
    # Longer words tend to be the meaningful ones (names, terms).
    seen.sort(key=len, reverse=True)
    return seen[:limit]


def _cosine(a, b) -> float:
    """Cosine similarity between two vectors."""
    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    return float(np.dot(a, b) / denom) if denom else 0.0


def _mmr_rerank(query_emb, candidates: list[dict], k: int, lambda_: float) -> list[dict]:
    """
    Maximal Marginal Relevance: pick k candidates that are each relevant to the
    query but NOT redundant with the ones already picked. Improves coverage within
    the token budget — done locally, no extra API calls.
    """
    sim_to_query = [_cosine(query_emb, c["embedding"]) for c in candidates]
    remaining = list(range(len(candidates)))
    selected: list[int] = []

    while remaining and len(selected) < k:
        if not selected:
            best = max(remaining, key=lambda i: sim_to_query[i])
        else:
            def mmr_score(i):
                redundancy = max(
                    _cosine(candidates[i]["embedding"], candidates[j]["embedding"])
                    for j in selected
                )
                return lambda_ * sim_to_query[i] - (1 - lambda_) * redundancy
            best = max(remaining, key=mmr_score)
        selected.append(best)
        remaining.remove(best)

    return [candidates[i] for i in selected]


def _match_named_source(question: str, sources: list[str]) -> str | None:
    """
    If the question names a specific document, return that document's source name.

    We score each source filename by how many of the question's key words appear
    in it, and pick the clear winner. This lets "summarize the book Ethics by
    Spinoza" pull chunks from 'ברוך שפינוזה-אתיקה.pdf' itself — instead of from
    other books that merely DISCUSS it (which otherwise rank higher for a
    "what is this book about" question).
    """
    q_words = {
        w.lower() for w in _WORD_RE.findall(question)
        if w.lower() not in _STOPWORDS
    }
    if not q_words:
        return None

    best, best_score = None, 0
    for source in sources:
        source_words = {w.lower() for w in _WORD_RE.findall(source)}
        score = len(q_words & source_words)
        if score > best_score:
            best, best_score = source, score

    # Require at least two shared words (e.g. author + title) so a single common
    # word doesn't wrongly lock the search onto one book.
    return best if best_score >= 2 else None


def retrieve_top_chunks(question: str, store, llm) -> list[dict]:
    """
    HYBRID retrieval + RERANKING:
      0. If the question NAMES a specific book, seed the pool from THAT book.
      1. Semantic (vector) search — a large candidate pool by meaning.
      2. Keyword search — chunks literally containing the question's key terms
         (catches exact names/terms the vector search may miss).
      3. MMR rerank — keep the FINAL_K best + most diverse candidates.
    """
    question_embedding = embed_text(question, llm)

    # --- 0/1. Build the semantic candidate pool ---
    named_source = _match_named_source(question, store.sources())
    if named_source:
        # Center the answer on the named book: most candidates come from it,
        # plus a few general ones for context/breadth.
        logger.info("Question names a specific document: %s", named_source)
        candidates = store.semantic_in_source(question_embedding, named_source, RERANK_POOL)
        seen_ids = {c["id"] for c in candidates}
        for c in store.semantic(question_embedding, KEYWORD_EXTRA):
            if c["id"] not in seen_ids:
                seen_ids.add(c["id"])
                candidates.append(c)
    else:
        candidates = store.semantic(question_embedding, RERANK_POOL)
        seen_ids = {c["id"] for c in candidates}

    # --- 2. Keyword candidates (not already in the pool) ---
    added = 0
    for term in _keywords(question):
        if added >= KEYWORD_EXTRA:
            break
        for hit in store.keyword(term, 3):
            if hit["id"] in seen_ids:
                continue
            seen_ids.add(hit["id"])
            candidates.append(hit)
            added += 1
            if added >= KEYWORD_EXTRA:
                break

    if not candidates:
        return []

    # --- 3. Rerank and trim ---
    best = _mmr_rerank(question_embedding, candidates, FINAL_K, MMR_LAMBDA)
    return [
        {"text": c["text"], "source": c["source"], "page_number": c["page_number"]}
        for c in best
    ]


# ---------------------------------------------------------------------------
# Step 5 — Build the prompt and call the model
# ---------------------------------------------------------------------------

def build_context_block(top_chunks: list[dict]) -> str:
    """Format retrieved chunks into a labeled context block for the model."""
    lines = []
    for chunk in top_chunks:
        label = f"{chunk['source']}, page {chunk['page_number']}"
        lines.append(f"[{label}]\n{chunk['text']}")
    return "\n\n".join(lines)


def build_messages(question: str, context_block: str, history: list[dict]) -> list[dict]:
    """
    Build the vendor-neutral message list for the provider.
    Prior turns give the model conversation memory; the final user turn carries
    the current question plus its retrieved excerpts.

    history is a list of {"role": "user" | "bot", "text": str}.
    Returned messages use roles "user" / "assistant" (the provider maps these).
    """
    # Keep only the most recent messages — caps the per-question cost so a long
    # conversation doesn't keep growing the input indefinitely.
    history = history[-MAX_HISTORY_MESSAGES:]

    messages = []
    for message in history:
        role = "user" if message["role"] == "user" else "assistant"
        messages.append({"role": role, "text": message["text"]})

    current_turn = (
        f"Document excerpts:\n\n{context_block}\n\n"
        f"Question: {question}"
    )
    messages.append({"role": "user", "text": current_turn})
    return messages


def rewrite_query(question: str, history: list[dict], llm) -> str:
    """
    Rewrite a follow-up question into a standalone search query using the recent
    conversation. Returns the original question unchanged when there's no history
    or if the rewrite fails (so retrieval never breaks over this).
    """
    if not history:
        return question

    recent = history[-6:]  # last few turns are enough to resolve references
    convo = "\n".join(
        f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['text']}"
        for m in recent
    )
    prompt = (
        f"Conversation so far:\n{convo}\n\n"
        f"Latest user message: {question}\n\n"
        f"Standalone search query:"
    )
    try:
        rewritten = llm.generate(REWRITE_SYSTEM_PROMPT, [{"role": "user", "text": prompt}])
        rewritten = (rewritten or "").strip()
        if rewritten and rewritten != question:
            logger.info("Rewrote query: %r -> %r", question[:60], rewritten[:60])
        return rewritten or question
    except Exception:
        logger.exception("Query rewrite failed — using the original question")
        return question


# ---------------------------------------------------------------------------
# RagEngine — ties everything together for reuse by the CLI and the API
# ---------------------------------------------------------------------------

class RagEngine:
    """
    Holds the LLM provider and a vector store for ONE corpus. Each corpus is
    isolated in its own store scope. Create one per corpus at startup, then answer().
    """

    def __init__(self, corpus_id: str, docs_dir: str | None = None):
        load_dotenv()
        self.corpus_id = corpus_id

        # The provider (Gemini / Azure / ...) is chosen via the LLM_PROVIDER env var.
        self.llm = get_provider()
        # One store per corpus, backend chosen by VECTOR_STORE (chroma | pgvector).
        # The scope name encodes the embedding model + chunk settings, so it keeps
        # incompatible vectors separate.
        self.store = make_store(collection_name(corpus_id, self.llm.embed_model))

        # If a local docs folder is given, index it now (the docs/ flow).
        if docs_dir is not None:
            if not os.path.isdir(docs_dir):
                raise NotADirectoryError(f"Documents folder not found: {docs_dir}")
            logger.info("Indexing documents in: %s", docs_dir)
            self._index_folder(docs_dir)

    def _index_folder(self, docs_dir: str) -> None:
        """Index every PDF in a local folder into the collection."""
        pdf_files = sorted(
            os.path.join(docs_dir, f)
            for f in os.listdir(docs_dir)
            if f.lower().endswith(".pdf")
        )
        logger.info("Found %d PDF file(s) in '%s'", len(pdf_files), docs_dir)
        for pdf_path in pdf_files:
            index_one_pdf(pdf_path, self.store, self.llm)
        logger.info("Index ready: %d chunks total", self.store.count())

    # --- Methods used by the SharePoint sync (in-memory indexing) ---

    def is_current(self, source: str, version: str) -> bool:
        """True if this source+version is already indexed (skip without downloading)."""
        return version_is_current(self.store, source, version)

    def index_bytes(self, source: str, version: str, data: bytes) -> int:
        """Index a PDF from in-memory bytes (no file saved to disk)."""
        return index_pdf_bytes(self.store, self.llm, source, version, data)

    def answer(self, question: str, history: list[dict] | None = None) -> dict:
        """
        Answer a question grounded in the documents, with conversation memory.
        history is the prior turns: [{"role": "user" | "bot", "text": str}, ...].
        Returns {"answer": str, "sources": [{"source": str, "page_number": int, "text": str}]}.
        """
        history = history or []

        # Resolve a follow-up ("that book", "he") into a standalone query BEFORE
        # retrieval, so search isn't driven by a context-less fragment. Retrieval
        # runs on the rewritten query; the answer still uses the user's own wording.
        search_query = rewrite_query(question, history, self.llm)
        top_chunks = retrieve_top_chunks(search_query, self.store, self.llm)
        context_block = build_context_block(top_chunks)

        # Safety guard: if there is no context, never call the model —
        # otherwise it might answer from its own outside knowledge.
        if not context_block.strip():
            return {"answer": NO_INFO_MESSAGE, "sources": []}

        messages = build_messages(question, context_block, history)
        answer_text = self.llm.generate(SYSTEM_PROMPT, messages)
        return {"answer": answer_text, "sources": top_chunks}


# ---------------------------------------------------------------------------
# Registry — one RagEngine per configured corpus
# ---------------------------------------------------------------------------

def build_registry() -> dict[str, RagEngine]:
    """
    Create one RagEngine per corpus defined in corpora.py, keyed by corpus id.
    Each engine has its own isolated collection. Built once at startup.
    """
    from corpora import all_corpora

    registry: dict[str, RagEngine] = {}
    for corpus in all_corpora():
        registry[corpus["id"]] = RagEngine(corpus["id"])
    return registry