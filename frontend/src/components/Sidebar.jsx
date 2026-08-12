import { useState } from "react";
import ConversationItem from "./ConversationItem";
import CorpusPicker from "./CorpusPicker";
import ConfirmDialog from "./ConfirmDialog";

// Side panel: corpus picker, the "new conversation" button, and the saved
// conversations of the currently selected corpus.

function Sidebar({
  corpora,
  selectedCorpusId,
  onSelectCorpus,
  conversations,
  activeId,
  onNew,
  onSelect,
  onDelete,
}) {
  // The conversation id awaiting delete confirmation (null = no dialog open).
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const pending = conversations.find((c) => c.id === pendingDeleteId) || null;

  function confirmDelete() {
    if (pendingDeleteId) onDelete(pendingDeleteId);
    setPendingDeleteId(null);
  }

  return (
    <aside className="sidebar">
      <CorpusPicker
        corpora={corpora}
        selectedId={selectedCorpusId}
        onSelect={onSelectCorpus}
      />

      <button className="new-conversation" onClick={onNew}>
        ＋ שיחה חדשה
      </button>

      <div className="conversation-list">
        {conversations.map((conversation) => (
          <ConversationItem
            key={conversation.id}
            conversation={conversation}
            active={conversation.id === activeId}
            onSelect={onSelect}
            onDelete={setPendingDeleteId} // ask first, then delete
          />
        ))}
      </div>

      {pending && (
        <ConfirmDialog
          title="מחיקת שיחה"
          message={`למחוק את השיחה "${pending.title || "שיחה חדשה"}"? הפעולה אינה הפיכה.`}
          confirmLabel="מחק"
          cancelLabel="ביטול"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}
    </aside>
  );
}

export default Sidebar;