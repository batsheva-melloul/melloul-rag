import { useRef, useState } from "react";
import { TEMPLATES } from "../data/templates";

// The bottom input area: a row of preset TEMPLATE chips (study guide / quiz /
// flashcards / summary) above an AUTO-GROWING textarea and the send button.
// Picking a template fills the input with a ready-made instruction; the user adds
// the topic and sends. Enter sends; Shift+Enter adds a new line.

const MAX_HEIGHT = 200; // px — matches .input max-height; beyond this it scrolls

function ChatInput({ onSend, disabled }) {
  const [text, setText] = useState("");
  const textareaRef = useRef(null);

  // Resize the textarea to fit its content (capped at MAX_HEIGHT).
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

  // Fill the input with a template's preset prompt and focus it, cursor at the end.
  function pickTemplate(template) {
    setText(template.prompt);
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    requestAnimationFrame(() => {
      autoGrow();
      el.selectionStart = el.selectionEnd = el.value.length;
    });
  }

  function handleSend() {
    if (!text.trim() || disabled) return;
    onSend(text);
    setText("");
    if (textareaRef.current) textareaRef.current.style.height = "auto"; // back to one line
  }

  function handleKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="input-area">
      <div className="template-bar">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            className="template-chip"
            onClick={() => pickTemplate(t)}
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
          placeholder="כתבו שאלה..."
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
