import { useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import DOMPurify from "dompurify";
import SourceTags from "./SourceTags";
import FlashCards from "./FlashCards";
import Quiz from "./Quiz";
import { downloadAnswer } from "../utils/download";

// A single chat message: an avatar plus the bubble with text and (for bot) sources.
// Bot answers are rendered as Markdown (bold, lists, TABLES via remark-gfm);
// user text stays plain.

// A fenced ```infographic (or ```svg) block holds model-generated HTML/SVG — we
// SANITIZE it (DOMPurify strips scripts / event handlers) and render it as a visual.
// Every other fenced code block renders as a normal <pre> code block.
function Pre({ children }) {
  const codeEl = Array.isArray(children) ? children[0] : children;
  const className = codeEl?.props?.className || "";
  const lang = /language-(\w+)/.exec(className)?.[1];
  const raw = String(codeEl?.props?.children ?? "").replace(/\n$/, "");

  // ```flashcards -> interactive flip cards.
  if (lang === "flashcards") {
    return <FlashCards text={raw} />;
  }
  // ```quiz -> interactive multiple-choice quiz with a score.
  if (lang === "quiz") {
    return <Quiz text={raw} />;
  }
  // ```infographic / ```svg -> sanitized HTML/SVG visual. Default DOMPurify keeps
  // styled HTML + SVG and strips only the dangerous parts (scripts, on* handlers,
  // javascript: URLs), so inline styling is preserved.
  if (lang === "infographic" || lang === "svg") {
    const clean = DOMPurify.sanitize(raw);
    return <div className="infographic" dangerouslySetInnerHTML={{ __html: clean }} />;
  }
  return <pre>{children}</pre>;
}

const MARKDOWN_COMPONENTS = { pre: Pre };

function MessageBubble({ message }) {
  const isUser = message.role === "user";
  const contentRef = useRef(null);
  const hasSources = !isUser && message.sources && message.sources.length > 0;

  return (
    <div className={`message-row ${isUser ? "user" : "bot"}`}>
      <div className="avatar">{isUser ? "🙂" : "🤖"}</div>
      <div className="bubble">
        {isUser ? (
          <div className="bubble-text">{message.text}</div>
        ) : (
          <div className="bubble-text markdown" ref={contentRef}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
              {message.text}
            </ReactMarkdown>
          </div>
        )}
        {!isUser && <SourceTags sources={message.sources} answer={message.text} />}
        {hasSources && (
          <button
            type="button"
            className="save-button"
            onClick={() => downloadAnswer(contentRef.current, message.text, "עוזר-החברה")}
            title="שמור את התשובה כקובץ"
          >
            ⬇ שמור כקובץ
          </button>
        )}
      </div>
    </div>
  );
}

export default MessageBubble;
