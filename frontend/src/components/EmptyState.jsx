// Friendly welcome message shown before the first question is asked.

function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-icon">💬</div>
      <h2>שלום! 👋</h2>
      <p>אני כאן כדי לעזור לך למצוא תשובות במסמכי החברה.</p>
      <p className="empty-hint">פשוט כתבו שאלה למטה כדי להתחיל.</p>
    </div>
  );
}

export default EmptyState;