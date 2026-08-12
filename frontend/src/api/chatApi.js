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
 * Send a question (plus the conversation so far) to a specific corpus and
 * return { answer, sources }. The accessToken authenticates the request.
 *
 * history: [{ role: "user" | "bot", text: string }, ...]
 */
export async function askQuestion(question, history = [], accessToken = "", corpusId) {
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
    }),
  });

  if (!response.ok) {
    throw new Error("Server error");
  }
  return response.json();
}