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