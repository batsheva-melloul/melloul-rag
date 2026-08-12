import { useState } from "react";
import { useMsal } from "@azure/msal-react";
import { InteractionStatus } from "@azure/msal-browser";
import { useTheme } from "../hooks/useTheme";
import ConfirmDialog from "./ConfirmDialog";

// The top bar of the chat: title, the signed-in user's name, a theme toggle,
// and a logout button.

function ChatHeader({ corpusName }) {
  const { instance, accounts, inProgress } = useMsal();
  const { theme, toggleTheme } = useTheme();
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const user = accounts[0];
  const displayName = user?.name || user?.username || "";

  // MSAL allows only one interaction at a time. Block logout while a sign-in
  // (or any other interaction) is still being processed.
  const busy = inProgress !== InteractionStatus.None;

  function handleLogout() {
    if (busy) return;
    instance.logoutRedirect({ account: user }).catch(() => {});
  }

  // Show the active corpus name; fall back to a greeting / default.
  const subtitle =
    corpusName || (displayName ? `שלום, ${displayName}` : "שאלו אותי כל דבר על המסמכים");

  return (
    <header className="chat-header">
      <div className="chat-header-avatar">🤖</div>
      <div className="chat-header-text">
        <h1>עוזר החברה</h1>
        <p>{subtitle}</p>
      </div>
      <button
        className="theme-toggle"
        onClick={toggleTheme}
        title={theme === "dark" ? "מצב בהיר" : "מצב כהה"}
        aria-label="החלף מצב תצוגה"
      >
        {theme === "dark" ? "☀️" : "🌙"}
      </button>
      {user && (
        <button
          className="logout-button"
          onClick={() => !busy && setConfirmingLogout(true)}
          disabled={busy}
        >
          התנתקות
        </button>
      )}

      {confirmingLogout && (
        <ConfirmDialog
          title="התנתקות"
          message="להתנתק מהמערכת?"
          confirmLabel="התנתק"
          cancelLabel="ביטול"
          danger={false}
          onConfirm={() => {
            setConfirmingLogout(false);
            handleLogout();
          }}
          onCancel={() => setConfirmingLogout(false)}
        />
      )}
    </header>
  );
}

export default ChatHeader;