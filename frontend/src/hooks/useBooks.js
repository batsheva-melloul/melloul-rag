import { useState, useEffect } from "react";
import { useMsal } from "@azure/msal-react";
import { fetchBooks } from "../api/chatApi";
import { getAccessToken } from "../auth/getToken";

/**
 * Loads the list of books (source filenames) for the given corpus and tracks
 * which ones are selected in the book-picker. An empty selectedBooks array means
 * "all books" (the default — search the whole corpus).
 *
 * Switching corpus reloads the books and clears the selection.
 */
export function useBooks(corpusId) {
  const { instance, accounts } = useMsal();
  const [books, setBooks] = useState([]);
  const [selectedBooks, setSelectedBooks] = useState([]);

  useEffect(() => {
    if (!corpusId) return;
    let cancelled = false;
    // A different corpus has a different set of books — reset the scope.
    setSelectedBooks([]);
    setBooks([]);
    (async () => {
      try {
        const token = await getAccessToken(instance, accounts);
        const list = await fetchBooks(corpusId, token);
        if (!cancelled) setBooks(list);
      } catch (error) {
        // Leave the list empty; the picker just shows "all books".
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [corpusId]);

  return { books, selectedBooks, setSelectedBooks };
}
