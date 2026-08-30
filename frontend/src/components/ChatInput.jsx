import { useRef, useState } from "react";
import { TEMPLATES } from "../data/templates";

// The bottom input area: a row of TEMPLATE chips (study guide / quiz / flashcards /
// summary) above an AUTO-GROWING textarea and the send button.
// Picking a template turns on a "mode": you then type ONLY the topic, and the full
// (hidden) instruction is sent behind the scenes — the chat shows just
// "🗂️ כרטיסיות: <topic>". Enter sends; Shift+Enter adds a new line.

const MAX_HEIGHT = 200; // px — matches .input max-height; beyond this it scrolls

// A book filename shown in the picker without its ".pdf" extension.
function bookLabel(name) {
  return name.replace(/\.pdf$/i, "");
}

function ChatInput({ onSend, disabled, books = [], selectedBooks = [], onSelectBooks }) {
  const [text, setText] = useState("");
  const [template, setTemplate] = useState(null); // active template, or null
  const textareaRef = useRef(null);

  // Books not yet chosen — the ones the "add a book" dropdown can still offer.
  const available = books.filter((b) => !selectedBooks.includes(b));

  function addBook(event) {
    const value = event.target.value;
    if (value && onSelectBooks) onSelectBooks([...selectedBooks, value]);
    event.target.value = ""; // reset back to the placeholder
  }
  function removeBook(book) {
    if (onSelectBooks) onSelectBooks(selectedBooks.filter((b) => b !== book));
  }

  function autoGrow() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }

  function handleChange(event) {
    setText(event.target.value);
    autoGrow();
  }

  // Toggle a template on/off; clicking the active one again turns the mode off.
  function toggleTemplate(picked) {
    setTemplate((current) => (current?.id === picked.id ? null : picked));
    textareaRef.current?.focus();
  }

  function handleSend() {
    const topic = text.trim();
    if (!topic || disabled) return;

    if (template) {
      // Chat shows a short label; the TOPIC is the search question, the template's
      // directive shapes the format, and comprehensive=true enables whole-book mode.
      const display = `${template.icon} ${template.label}: ${topic}`;
      onSend(display, topic, template.directive, true, selectedBooks);
    } else {
      onSend(topic, topic, "", false, selectedBooks);
    }

    setText("");
    setTemplate(null);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }

  function handleKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

  const placeholder = template
    ? `הקלידו נושא ל"${template.label}"...`
    : "כתבו שאלה...";

  return (
    <div className="input-area">
      {books.length > 0 && (
        <div className="book-picker">
          <span className="book-picker-label">📚 שאלו מתוך:</span>

          {selectedBooks.length === 0 ? (
            <span className="book-all">כל הספרים</span>
          ) : (
            <div className="book-chips">
              {selectedBooks.map((b) => (
                <span key={b} className="book-chip">
                  {bookLabel(b)}
                  <button
                    type="button"
                    className="book-chip-x"
                    onClick={() => removeBook(b)}
                    disabled={disabled}
                    aria-label={`הסר ${bookLabel(b)}`}
                  >
                    ×
                  </button>
                </span>
              ))}
              <button
                type="button"
                className="book-clear"
                onClick={() => onSelectBooks && onSelectBooks([])}
                disabled={disabled}
              >
                נקה הכל
              </button>
            </div>
          )}

          {available.length > 0 && (
            <select
              className="book-select"
              value=""
              onChange={addBook}
              disabled={disabled}
              title="הוסיפו ספר לרשימה"
            >
              <option value="">
                {selectedBooks.length ? "➕ הוסיפו ספר…" : "➕ בחרו ספר…"}
              </option>
              {available.map((b) => (
                <option key={b} value={b}>
                  {bookLabel(b)}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <div className="template-bar">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`template-chip${template?.id === t.id ? " active" : ""}`}
            onClick={() => toggleTemplate(t)}
            disabled={disabled}
            title={t.label}
          >
            <span className="template-chip-icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      <div className="input-row">
        <textarea
          ref={textareaRef}
          className="input"
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
        />
        <button
          className="send-button"
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          aria-label="שלח"
        >
          ➤
        </button>
      </div>
    </div>
  );
}

export default ChatInput;
