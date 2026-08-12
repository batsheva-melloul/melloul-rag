import { useState } from "react";

// Light/dark theme. The initial value is applied to <html data-theme="..."> in
// main.jsx (before first paint, so there's no flash). This hook just lets the
// header toggle it and persists the choice in localStorage.

const STORAGE_KEY = "rag_theme";

export function useTheme() {
  const [theme, setTheme] = useState(
    () => document.documentElement.dataset.theme || "light"
  );

  function toggleTheme() {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // ignore storage errors (e.g. private mode)
      }
      return next;
    });
  }

  return { theme, toggleTheme };
}