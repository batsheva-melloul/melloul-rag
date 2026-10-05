import { useRef, useEffect } from "react";
import MessageBubble from "./MessageBubble";
import TypingIndicator from "./TypingIndicator";
import EmptyState from "./EmptyState";

// The scrollable area holding all messages.
// Auto-scrolls to the newest message whenever the list or loading state changes.

function MessageList({ messages, loading }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  return (
    <div className="message-list">
      {messages.length === 0 && !loading && <EmptyState />}

      {messages.map((message, index) => (
        <MessageBubble key={index} message={message} />
      ))}

      {/* The "..." indicator shows only until the answer starts streaming in. */}
      {loading && !messages[messages.length - 1]?.streaming && <TypingIndicator />}

      <div ref={bottomRef} />
    </div>
  );
}

export default MessageList;