import { useEffect } from "react";
import { createPortal } from "react-dom";

// A small themed confirmation modal. Rendered into document.body via a portal
// so the fixed overlay covers the whole viewport (the sidebar's backdrop-filter
// would otherwise trap a fixed child inside it). Click the backdrop, press
// Escape, or click Cancel to dismiss; Confirm runs the action.

function ConfirmDialog({
  title,
  message,
  confirmLabel = "אישור",
  cancelLabel = "ביטול",
  danger = true, // red confirm button (for destructive actions like delete)
  onConfirm,
  onCancel,
}) {
  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        {title && <h3 className="modal-title">{title}</h3>}
        <p className="modal-message">{message}</p>
        <div className="modal-actions">
          <button className="modal-btn cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className={`modal-btn ${danger ? "danger" : "confirm"}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default ConfirmDialog;
