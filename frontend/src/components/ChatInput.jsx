import { useState } from "react";

// The bottom input row: a growing textarea plus a send button.
// Enter sends; Shift+Enter adds a new line.

function ChatInput({ onSend, disabled }) {
  const [text, setText] = useState("");

  function handleSend() {
    if (!text.trim() || disabled) return;
    onSend(text);
    setText("");
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
        className="input"
        value={text}
        onChange={(e) => setText(e.target.value)}
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