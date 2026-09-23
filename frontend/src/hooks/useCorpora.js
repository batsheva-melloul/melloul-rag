import { useState, useEffect } from "react";
import { useMsal } from "@azure/msal-react";
import { fetchCorpora } from "../api/chatApi";
import { getAccessToken } from "../auth/getToken";
import { peekPendingQuestion } from "../auth/pendingQuestion";

/**
 * Loads the list of chatbots/corpora from the backend and tracks which one
 * is currently selected. The selected corpus drives the whole chat view.
 */
export function useCorpora() {
  const { instance, accounts } = useMsal();
  const [corpora, setCorpora] = useState([]);
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getAccessToken(instance, accounts);
        const list = await fetchCorpora(token);
        if (cancelled) return;
        setCorpora(list);
        // Default to the corpus of a question parked across a sign-in
        // redirect (so it can be resent there), otherwise the first corpus.
        const pending = peekPendingQuestion();
        const pendingCorpus =
          pending && list.some((c) => c.id === pending.corpusId) ? pending.corpusId : null;
        setSelectedId((prev) => prev || pendingCorpus || (list[0] && list[0].id) || null);
      } catch (error) {
        // Leave the list empty; the UI shows nothing to pick.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { corpora, selectedId, setSelectedId };
}