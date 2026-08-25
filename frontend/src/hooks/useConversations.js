import { useState, useEffect } from "react";
import { useMsal } from "@azure/msal-react";
import { askQuestion } from "../api/chatApi";
import { getAccessToken } from "../auth/getToken";

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
  async function sendQuestion(displayText, questionText, directive = "", comprehensive = false) {
    const shown = (displayText || "").trim();
    const question = (questionText ?? displayText ?? "").trim();
    if (!shown || loading || !active) return;

    const history = active.messages;

    updateActive((c) => ({
      ...c,
      title: c.messages.length === 0 ? shown.slice(0, 30) : c.title,
      messages: [...c.messages, { role: "user", text: shown }],
      updatedAt: Date.now(),
    }));
    setLoading(true);

    try {
      const token = await getAccessToken(instance, accounts);
      const data = await askQuestion(question, history, token, corpusId, directive, comprehensive);
      updateActive((c) => ({
        ...c,
        messages: [
          ...c.messages,
          { role: "bot", text: data.answer, sources: data.sources },
        ],
        updatedAt: Date.now(),
      }));
    } catch (error) {
      updateActive((c) => ({
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