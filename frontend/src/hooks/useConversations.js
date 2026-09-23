import { useState, useEffect } from "react";
import { useMsal } from "@azure/msal-react";
import { askQuestion } from "../api/chatApi";
import { getAccessToken, RedirectingError } from "../auth/getToken";
import { savePendingQuestion, takePendingQuestion } from "../auth/pendingQuestion";

// Conversations are persisted in the browser's localStorage. Each conversation
// is tagged with the corpus (chatbot) it belongs to.
const STORAGE_KEY = "rag_conversations";

function loadConversations() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// Unique-enough ID without crypto.randomUUID (unavailable over plain http LAN).
function makeId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function createConversation(corpusId) {
  return {
    id: makeId(),
    corpusId,
    title: "שיחה חדשה",
    messages: [],
    updatedAt: Date.now(),
  };
}

/**
 * Manages conversations for the CURRENTLY SELECTED corpus.
 * Switching corpus shows that corpus's own conversations.
 */
export function useConversations(corpusId) {
  const { instance, accounts } = useMsal();
  const [conversations, setConversations] = useState(loadConversations);
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(false);

  // Persist on every change.
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  }, [conversations]);

  // Make sure there is an active conversation belonging to the current corpus.
  useEffect(() => {
    if (!corpusId) return;
    const active = conversations.find((c) => c.id === activeId);
    if (active && active.corpusId === corpusId) return;

    const empty = conversations.find(
      (c) => c.corpusId === corpusId && c.messages.length === 0
    );
    if (empty) {
      setActiveId(empty.id);
      return;
    }
    const conversation = createConversation(corpusId);
    setConversations((prev) => [conversation, ...prev]);
    setActiveId(conversation.id);
  }, [corpusId, conversations, activeId]);

  const active = conversations.find((c) => c.id === activeId) || null;

  function updateActive(updater) {
    setConversations((prev) =>
      prev.map((c) => (c.id === activeId ? updater(c) : c))
    );
  }

  // `displayText` is what the user sees in the chat; `questionText` (optional) is
  // the actual search/answer question; `directive` (optional) is a template's
  // formatting instruction. For template buttons the bubble shows a short label
  // ("🗂️ כרטיסיות: <נושא>") while the topic is searched and the directive shapes
  // the format — kept apart so search matches the topic, not the boilerplate.
  async function sendQuestion(displayText, questionText, directive = "", comprehensive = false, books = [], templateId = null) {
    const shown = (displayText || "").trim();
    const question = (questionText ?? displayText ?? "").trim();
    if (!shown || loading || !active) return;

    const history = active.messages;
    // Books this question was scoped to (from the book-picker chips), if any.
    const scopedBooks = Array.isArray(books) ? books : [];

    updateActive((c) => ({
      ...c,
      title: c.messages.length === 0 ? shown.slice(0, 30) : c.title,
      messages: [...c.messages, { role: "user", text: shown, books: scopedBooks }],
      updatedAt: Date.now(),
    }));

    await runQuestion(
      { conversationId: active.id, corpusId, shown, question, directive, comprehensive, books: scopedBooks, templateId },
      history
    );
  }

  // Fetch the answer for a question whose user bubble is already in the
  // conversation, and append the bot turn. Shared by sendQuestion and by the
  // resume-after-sign-in path below.
  async function runQuestion(q, history) {
    const applyTo = (updater) =>
      setConversations((prev) => prev.map((c) => (c.id === q.conversationId ? updater(c) : c)));

    setLoading(true);
    try {
      const token = await getAccessToken(instance, accounts);
      const data = await askQuestion(q.question, history, token, q.corpusId, q.directive, q.comprehensive, q.books);
      applyTo((c) => ({
        ...c,
        messages: [
          ...c.messages,
          // Keep the question + its book scope on the bot turn too, so "save as
          // file" can include both. `template` marks which preset produced it
          // (e.g. "presentation") so the UI can offer the right export.
          { role: "bot", text: data.answer, sources: data.sources,
            wholeBook: data.whole_book, question: q.shown, books: q.books,
            template: q.templateId },
        ],
        updatedAt: Date.now(),
      }));
    } catch (error) {
      if (error instanceof RedirectingError) {
        // The sign-in expired and the page is about to navigate to Microsoft.
        // Park the question so it is sent automatically when we are back.
        savePendingQuestion(q);
        return; // no error bubble: the page unloads in a moment
      }
      applyTo((c) => ({
        ...c,
        messages: [
          ...c.messages,
          { role: "bot", text: "אירעה שגיאה בחיבור לשרת. נסה שוב.", sources: [] },
        ],
      }));
    } finally {
      setLoading(false);
    }
  }

  // After a sign-in redirect: if a question was parked before we left, open
  // its conversation and send it now. Runs once, when the corpus is known.
  useEffect(() => {
    if (!corpusId) return;
    const pending = takePendingQuestion();
    if (!pending) return;
    const conversation = conversations.find((c) => c.id === pending.conversationId);
    if (!conversation) return;
    setActiveId(conversation.id);
    // The user bubble was already appended before the redirect, so the
    // history the model sees must stop just before it.
    const last = conversation.messages[conversation.messages.length - 1];
    const history =
      last && last.role === "user" && last.text === pending.shown
        ? conversation.messages.slice(0, -1)
        : conversation.messages;
    runQuestion(pending, history);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corpusId]);

  function newConversation() {
    const empty = conversations.find(
      (c) => c.corpusId === corpusId && c.messages.length === 0
    );
    if (empty) {
      setActiveId(empty.id);
      return;
    }
    const conversation = createConversation(corpusId);
    setConversations((prev) => [conversation, ...prev]);
    setActiveId(conversation.id);
  }

  function selectConversation(id) {
    setActiveId(id);
  }

  function deleteConversation(id) {
    const remaining = conversations.filter((c) => c.id !== id);
    setConversations(remaining);
    if (id === activeId) {
      const next = remaining.find((c) => c.corpusId === corpusId);
      setActiveId(next ? next.id : null); // the effect re-creates one if needed
    }
  }

  // Only this corpus's non-empty conversations appear in the list.
  const visible = conversations.filter(
    (c) => c.corpusId === corpusId && c.messages.length > 0
  );

  return {
    conversations: visible,
    activeId,
    messages: active ? active.messages : [],
    loading,
    sendQuestion,
    newConversation,
    selectConversation,
    deleteConversation,
  };
}