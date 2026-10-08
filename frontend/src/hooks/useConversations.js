import { useState, useEffect, useRef } from "react";
import { useMsal } from "@azure/msal-react";
import {
  askQuestionStream,
  fetchConversations,
  saveConversation,
  deleteConversationRemote,
} from "../api/chatApi";
import { getAccessToken, RedirectingError } from "../auth/getToken";
import { savePendingQuestion, takePendingQuestion } from "../auth/pendingQuestion";

// Conversations live on the SERVER (per signed-in user, see /conversations), so
// the same history appears on every device. localStorage keeps a copy as a
// cache: it renders instantly on load and still works if the server is briefly
// unreachable. Each conversation is tagged with the corpus it belongs to.
const STORAGE_KEY = "rag_conversations";
// How long to wait after the last change before writing it to the server.
const SAVE_DEBOUNCE_MS = 1200;

// Merge the cached and the server copies: every id from both sides, and where
// both have one, the more recently updated wins.
function mergeConversations(local, remote) {
  const byId = new Map();
  for (const c of remote) byId.set(c.id, c);
  for (const c of local) {
    const r = byId.get(c.id);
    if (!r || (c.updatedAt || 0) > (r.updatedAt || 0)) byId.set(c.id, c);
  }
  return [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

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

  // Persist the cache on every change.
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  }, [conversations]);

  // --- Server sync -----------------------------------------------------------
  // loadedRef: the server copy has been merged in (saves are allowed from then
  // on, so a stale cache can never overwrite newer server data).
  // savedRef: per conversation, the JSON we last sent, to detect real changes.
  const loadedRef = useRef(false);
  const savedRef = useRef(new Map());
  const saveTimerRef = useRef(null);

  // Fetch this user's conversations and merge them with the cache. Cached
  // conversations the server has never seen (from before server-side history
  // existed) are uploaded once, so nothing is lost in the migration.
  //
  // Saves are allowed ONLY after one merge has succeeded: PUT replaces the whole
  // conversation, so if the load failed and we saved anyway, a stale cached copy
  // (e.g. an older copy on a second device) could overwrite newer server data.
  // Until then, every change retries the load instead of saving; the cache
  // still holds everything, and saving resumes the moment the server answers.
  const mountedRef = useRef(true);
  const loadingRef = useRef(false);
  async function loadFromServer() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const token = await getAccessToken(instance, accounts);
      const remote = await fetchConversations(token);
      if (!mountedRef.current) return;
      const remoteIds = new Set(remote.map((c) => c.id));
      for (const c of remote) savedRef.current.set(c.id, JSON.stringify(c));
      setConversations((local) => {
        const merged = mergeConversations(local, remote);
        for (const c of local) {
          if (!remoteIds.has(c.id) && c.messages.length > 0) {
            saveConversation(c, token).then(
              () => savedRef.current.set(c.id, JSON.stringify(c)),
              () => {}
            );
          }
        }
        return merged;
      });
      loadedRef.current = true;
    } catch {
      // Offline / sign-in redirect in progress: keep working from the cache.
    } finally {
      loadingRef.current = false;
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    loadFromServer();
    return () => {
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After every change: write conversations that actually changed, debounced.
  // Empty conversations and ones with an answer still streaming are skipped.
  useEffect(() => {
    if (!loadedRef.current) {
      loadFromServer(); // not merged yet (see above): retry the load, don't save
      return undefined;
    }
    const dirty = conversations.filter((c) => {
      if (c.messages.length === 0) return false;
      if (c.messages[c.messages.length - 1]?.streaming) return false;
      return savedRef.current.get(c.id) !== JSON.stringify(c);
    });
    if (dirty.length === 0) return undefined;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        const token = await getAccessToken(instance, accounts);
        for (const c of dirty) {
          const snapshot = JSON.stringify(c);
          await saveConversation(c, token);
          savedRef.current.set(c.id, snapshot);
        }
      } catch {
        // Will retry on the next change; the cache still has everything.
      }
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(saveTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  //
  // The answer is STREAMED: as soon as the first piece of text arrives we add a
  // bot bubble flagged `streaming: true` and keep replacing its text, so the
  // user reads the answer while the model is still writing. When the stream
  // ends the bubble gets its sources and the flag is cleared.
  async function runQuestion(q, history) {
    const applyTo = (updater) =>
      setConversations((prev) => prev.map((c) => (c.id === q.conversationId ? updater(c) : c)));

    // Identifies the live bubble inside the conversation while it streams.
    const streamId = makeId();
    let started = false;

    // Replace the streaming bubble's text. Updates are coalesced to one per
    // animation frame: tokens can arrive far faster than Markdown re-renders.
    let pendingText = null;
    let frame = null;
    const flush = () => {
      frame = null;
      if (pendingText === null) return;
      const text = pendingText;
      pendingText = null;
      applyTo((c) => ({
        ...c,
        messages: c.messages.map((m) => (m.streamId === streamId ? { ...m, text } : m)),
      }));
    };
    const onDelta = (text) => {
      if (!started) {
        started = true;
        applyTo((c) => ({
          ...c,
          messages: [
            ...c.messages,
            { role: "bot", text, sources: [], streaming: true, streamId,
              question: q.shown, books: q.books, template: q.templateId },
          ],
        }));
        return;
      }
      pendingText = text;
      if (frame === null) frame = requestAnimationFrame(flush);
    };

    setLoading(true);
    try {
      const token = await getAccessToken(instance, accounts);
      const data = await askQuestionStream(
        { question: q.question, history, accessToken: token, corpusId: q.corpusId,
          directive: q.directive, comprehensive: q.comprehensive, books: q.books },
        onDelta
      );
      if (frame !== null) cancelAnimationFrame(frame);
      pendingText = null;
      // Final bot turn. Keep the question + its book scope on it too, so "save
      // as file" can include both. `template` marks which preset produced it
      // (e.g. "presentation") so the UI can offer the right export.
      const finalMessage = {
        role: "bot", text: data.answer, sources: data.sources,
        wholeBook: data.whole_book, question: q.shown, books: q.books,
        template: q.templateId,
      };
      applyTo((c) => ({
        ...c,
        messages: started
          ? c.messages.map((m) => (m.streamId === streamId ? finalMessage : m))
          : [...c.messages, finalMessage],
        updatedAt: Date.now(),
      }));
    } catch (error) {
      if (frame !== null) cancelAnimationFrame(frame);
      pendingText = null;
      if (error instanceof RedirectingError) {
        // The sign-in expired and the page is about to navigate to Microsoft.
        // Park the question so it is sent automatically when we are back.
        savePendingQuestion(q);
        return; // no error bubble: the page unloads in a moment
      }
      const errorMessage = { role: "bot", text: "אירעה שגיאה בחיבור לשרת. נסה שוב.", sources: [] };
      applyTo((c) => ({
        ...c,
        // If some text already streamed in, keep it and append the error after it.
        messages: started
          ? [...c.messages.map((m) => (m.streamId === streamId ? { ...m, streaming: false } : m)), errorMessage]
          : [...c.messages, errorMessage],
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
    savedRef.current.delete(id);
    getAccessToken(instance, accounts)
      .then((token) => deleteConversationRemote(id, token))
      .catch(() => {});
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