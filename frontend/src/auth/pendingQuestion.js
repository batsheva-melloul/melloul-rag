// A question the user sent while their sign-in had expired. We must redirect
// to Microsoft to renew the token, which unloads the page — so the question is
// parked here (sessionStorage survives the round trip) and sent automatically
// once we are back and signed in. That way the user never has to notice the
// renewal, let alone retype anything.
const KEY = "rag_pending_question";

export function savePendingQuestion(pending) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(pending));
  } catch {
    // Storage unavailable — the user will simply re-ask.
  }
}

export function takePendingQuestion() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function peekPendingQuestion() {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
