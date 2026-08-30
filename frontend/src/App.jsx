import { useMsal, useIsAuthenticated } from "@azure/msal-react";
import { InteractionStatus } from "@azure/msal-browser";
import Sidebar from "./components/Sidebar";
import ChatHeader from "./components/ChatHeader";
import MessageList from "./components/MessageList";
import ChatInput from "./components/ChatInput";
import LoginScreen from "./components/LoginScreen";
import { useConversations } from "./hooks/useConversations";
import { useCorpora } from "./hooks/useCorpora";
import { useBooks } from "./hooks/useBooks";
import { DEMO_MODE } from "./config";

// The top-level component decides what to show:
// - DEMO_MODE      -> the chat app directly (no sign-in)
// - Signed in      -> the chat app
// - Not signed in  -> the login screen
function App() {
  if (DEMO_MODE) {
    return <ChatApp />;
  }
  return <AuthGate />;
}

// Gate that waits for MSAL to finish any sign-in/sign-out before deciding what
// to show. This prevents the login screen from flashing mid-redirect (which
// caused the "click login twice" issue).
function AuthGate() {
  const { inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();

  if (inProgress !== InteractionStatus.None) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="login-icon">⏳</div>
          <p>מתחבר...</p>
        </div>
      </div>
    );
  }

  return isAuthenticated ? <ChatApp /> : <LoginScreen />;
}

// The actual chat app, shown only to signed-in users.
function ChatApp() {
  const { corpora, selectedId, setSelectedId } = useCorpora();
  const { books, selectedBooks, setSelectedBooks } = useBooks(selectedId);
  const {
    conversations,
    activeId,
    messages,
    loading,
    sendQuestion,
    newConversation,
    selectConversation,
    deleteConversation,
  } = useConversations(selectedId);

  const selectedCorpus = corpora.find((c) => c.id === selectedId);

  return (
    <div className="app">
      {/* Full-width top bar, spanning across the sidebar and the chat */}
      <ChatHeader corpusName={selectedCorpus ? selectedCorpus.name : ""} />

      <div className="app-body">
        <Sidebar
          corpora={corpora}
          selectedCorpusId={selectedId}
          onSelectCorpus={setSelectedId}
          conversations={conversations}
          activeId={activeId}
          onNew={newConversation}
          onSelect={selectConversation}
          onDelete={deleteConversation}
        />

        <div className="chat-card">
          <MessageList messages={messages} loading={loading} />
          <ChatInput
            onSend={sendQuestion}
            disabled={loading}
            books={books}
            selectedBooks={selectedBooks}
            onSelectBooks={setSelectedBooks}
          />
        </div>
      </div>
    </div>
  );
}

export default App;