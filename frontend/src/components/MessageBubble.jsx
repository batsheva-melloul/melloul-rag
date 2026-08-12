import ReactMarkdown from "react-markdown";
import SourceTags from "./SourceTags";

// A single chat message: an avatar plus the bubble with text and (for bot) sources.
// Bot answers are rendered as Markdown (bold, lists, etc.); user text stays plain.

function MessageBubble({ message }) {
  const isUser = message.role === "user";

  return (
    <div className={`message-row ${isUser ? "user" : "bot"}`}>
      <div className="avatar">{isUser ? "🙂" : "🤖"}</div>
      <div className="bubble">
        {isUser ? (
          <div className="bubble-text">{message.text}</div>
        ) : (
          <div className="bubble-text markdown">
            <ReactMarkdown>{message.text}</ReactMarkdown>
          </div>
        )}
        {!isUser && <SourceTags sources={message.sources} answer={message.text} />}
      </div>
    </div>
  );
}

export default MessageBubble;