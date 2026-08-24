import { useRef, useState } from "react";

// The bottom input row: an AUTO-GROWING textarea plus a send button.
// The textarea gets taller as you type (up to a max), then scrolls — so a long
// question is visible without scrolling inside a one-line box.
// Enter sends; Shift+Enter adds a new line.

const MAX_HEIGHT = 200; // px — matches .input max-height; beyond this it scrolls

function ChatInput({ onSend, disabled }) {
  const [text, setText] = useState("");
  const textareaRef = useRef(null);

  // Resize the textarea to fit its content (capped at MAX_HEIGHT).
  function autoGrow() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";                                  // shrink first, so it can also get smaller
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }

  function handleChange(event) {
    setText(event.target.value);
    autoGrow();
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
  );
}

export default ChatInput;
