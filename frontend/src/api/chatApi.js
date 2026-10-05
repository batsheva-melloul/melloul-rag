// All communication with the FastAPI backend lives here.
import { API_BASE } from "../config";

/**
 * Fetch the list of available chatbots/corpora: [{ id, name }, ...].
 */
export async function fetchCorpora(accessToken = "") {
  const response = await fetch(`${API_BASE}/corpora`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error("Failed to load corpora");
  }
  return response.json();
}

/**
 * Fetch the list of book (source) filenames in a corpus, for the book-picker.
 * Returns a sorted array of strings.
 */
export async function fetchBooks(corpusId, accessToken = "") {
  const response = await fetch(
    `${API_BASE}/books?corpus_id=${encodeURIComponent(corpusId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!response.ok) {
    throw new Error("Failed to load books");
  }
  return response.json();
}

/**
 * Send a question (plus the conversation so far) to a specific corpus and
 * return { answer, sources }. The accessToken authenticates the request.
 *
 * history: [{ role: "user" | "bot", text: string }, ...]
 * books (optional): exact source filenames to confine retrieval to those book(s).
 */
export async function askQuestion(
  question, history = [], accessToken = "", corpusId,
  directive = "", comprehensive = false, books = []
) {
  const trimmedHistory = history.map((m) => ({ role: m.role, text: m.text }));

  const response = await fetch(`${API_BASE}/ask`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      question,
      history: trimmedHistory,
      corpus_id: corpusId,
      directive,
      comprehensive,
      books,
    }),
  });

  if (!response.ok) {
    throw new Error("Server error");
  }
  return response.json();
}

/**
 * Streaming version of askQuestion. The server answers with Server-Sent Events
 * (`data: {json}` lines) while the model is still writing; each event is:
 *   {type:"delta", text}                      a piece of the answer
 *   {type:"done", sources, whole_book}        always last
 *   {type:"error", message}                   something broke mid-way
 * `onDelta(fullTextSoFar)` is called as text arrives. Resolves to the same
 * { answer, sources, whole_book } shape as askQuestion once the stream ends.
 * Falls back to the one-shot endpoint when the browser cannot read streams.
 */
export async function askQuestionStream(
  { question, history = [], accessToken = "", corpusId,
    directive = "", comprehensive = false, books = [] },
  onDelta
) {
  const body = JSON.stringify({
    question,
    history: history.map((m) => ({ role: m.role, text: m.text })),
    corpus_id: corpusId,
    directive,
    comprehensive,
    books,
  });

  const response = await fetch(`${API_BASE}/ask/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body,
  });
  if (!response.ok) {
    throw new Error("Server error");
  }
  if (!response.body || !response.body.getReader) {
    // Very old browser: no ReadableStream. Use the one-shot endpoint instead.
    return askQuestion(question, history, accessToken, corpusId, directive, comprehensive, books);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let answer = "";
  let result = null;

  const handle = (rawLine) => {
    let line = rawLine.trim();
    if (!line || line.startsWith(":")) return; // blank separator / SSE comment
    if (line.startsWith("data:")) line = line.slice(5).trim();
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return; // ignore a malformed line rather than killing the answer
    }
    if (event.type === "delta") {
      answer += event.text || "";
      if (onDelta) onDelta(answer);
    } else if (event.type === "done") {
      result = { answer, sources: event.sources || [], whole_book: !!event.whole_book };
    } else if (event.type === "error") {
      throw new Error(event.message || "Server error");
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep the last, possibly incomplete, line
    for (const line of lines) handle(line);
  }
  buffer += decoder.decode();
  if (buffer.trim()) handle(buffer);

  if (!result) {
    // The stream ended without a "done" event (connection dropped mid-answer).
    if (answer.trim()) return { answer, sources: [], whole_book: false };
    throw new Error("Stream ended unexpectedly");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Small helper for the JSON endpoints below (GET/PUT/DELETE with a bearer token).
// Throws an Error whose message is the HTTP status, so callers can tell 403/409.
// ---------------------------------------------------------------------------
async function json(path, { method = "GET", body, accessToken = "" } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${accessToken}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

/** The signed-in user as the backend sees them: { name, email, isAdmin }. */
export function fetchMe(accessToken = "") {
  return json("/me", { accessToken });
}

// --- Server-side conversation history -------------------------------------

/** All of this user's conversations (every corpus). */
export function fetchConversations(accessToken = "") {
  return json("/conversations", { accessToken });
}

/** Create or update one conversation (the whole document). */
export function saveConversation(conversation, accessToken = "") {
  const { id, corpusId, title, messages, updatedAt } = conversation;
  return json(`/conversations/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: { id, corpusId, title: title || "", messages, updatedAt: updatedAt || Date.now() },
    accessToken,
  });
}

export function deleteConversationRemote(id, accessToken = "") {
  return json(`/conversations/${encodeURIComponent(id)}`, { method: "DELETE", accessToken });
}

// --- Admin page -------------------------------------------------------------

export function fetchAdminOverview(days = 7, accessToken = "") {
  return json(`/admin/overview?days=${days}`, { accessToken });
}

export function fetchAdminQuestions({ limit = 100, corpusId = "", status = "" } = {}, accessToken = "") {
  const params = new URLSearchParams({ limit: String(limit) });
  if (corpusId) params.set("corpus_id", corpusId);
  if (status) params.set("status", status);
  return json(`/admin/questions?${params}`, { accessToken });
}

export function startAdminSync(corpusId, accessToken = "") {
  return json(`/admin/sync?corpus_id=${encodeURIComponent(corpusId)}`, { method: "POST", accessToken });
}

export function fetchAdminSyncStatus(accessToken = "") {
  return json("/admin/sync/status", { accessToken });
}
