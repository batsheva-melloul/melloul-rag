// A single row in the conversation list: its title plus a delete button.

function ConversationItem({ conversation, active, onSelect, onDelete }) {
  return (
    <div
      className={`conversation-item ${active ? "active" : ""}`}
      onClick={() => onSelect(conversation.id)}
    >
      <span className="conversation-title">
        {conversation.title || "שיחה חדשה"}
      </span>
      <button
        className="delete-conversation"
        onClick={(event) => {
          event.stopPropagation(); // don't also select the conversation
          onDelete(conversation.id);
        }}
        aria-label="מחק שיחה"
      >
        {/* SVG trash icon — uses currentColor, so it stays visible in both
            light and dark themes (an emoji can't be recolored by CSS). */}
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
        </svg>
      </button>
    </div>
  );
}

export default ConversationItem;