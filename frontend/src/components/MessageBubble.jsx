import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import DOMPurify from "dompurify";
import SourceTags from "./SourceTags";

// A single chat message: an avatar plus the bubble with text and (for bot) sources.
// Bot answers are rendered as Markdown (bold, lists, TABLES via remark-gfm);
// user text stays plain.

// A fenced ```infographic (or ```svg) block holds model-generated HTML/SVG — we
// SANITIZE it (DOMPurify strips scripts / event handlers) and render it as a visual.
// Every other fenced code block renders as a normal <pre> code block.
function Pre({ children }) {
  const codeEl = Array.isArray(children) ? children[0] : children;
  const className = codeEl?.props?.className || "";
  const isVisual = /language-(infographic|svg)/.test(className);

  if (isVisual) {
    const raw = String(codeEl?.props?.children ?? "").replace(/\n$/, "");
    // Default DOMPurify keeps styled HTML + SVG and strips only the dangerous parts
    // (scripts, on* handlers, javascript: URLs) — so inline styling is preserved.
    const clean = DOMPurify.sanitize(raw);
    return <div className="infographic" dangerouslySetInnerHTML={{ __html: clean }} />;
  }
  return <pre>{children}</pre>;
}

const MARKDOWN_COMPONENTS = { pre: Pre };

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
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
              {message.text}
            </ReactMarkdown>
          </div>
        )}
        {!isUser && <SourceTags sources={message.sources} answer={message.text} />}
      </div>
    </div>
  );
}

export default MessageBubble;
