# Frontend — React (plain JavaScript)

Friendly chat UI built with **React** and **plain JavaScript** (`.jsx`, never `.tsx`).
Bundled and served by **Vite**. NOT TypeScript. NOT Next.js.

## Files

```
frontend/
├── index.html              # HTML shell (RTL, Hebrew)
├── vite.config.js          # Vite + React plugin config
├── package.json            # Dependencies and scripts
└── src/
    ├── main.jsx            # React entry point — mounts <App>
    ├── App.jsx             # Composition root — wires components together (no logic)
    ├── index.css           # All styling (modern glassmorphism, RTL, animations)
    ├── api/
    │   └── chatApi.js      # The single place that talks to the backend (fetch /ask)
    ├── hooks/
    │   └── useConversations.js  # All conversations, active one, send logic, localStorage persistence
    └── components/
        ├── Sidebar.jsx         # "New conversation" button + conversation list
        ├── ConversationItem.jsx# One row in the conversation list (title + delete)
        ├── ChatHeader.jsx      # Top bar with title + avatar
        ├── MessageList.jsx     # Scrollable list + auto-scroll to newest
        ├── MessageBubble.jsx   # One message (avatar + bubble)
        ├── SourceTags.jsx      # Citation pills (📄 source · page N)
        ├── TypingIndicator.jsx # Animated "..." while waiting
        ├── EmptyState.jsx      # Welcome screen before first question
        └── ChatInput.jsx       # Textarea + send button (Enter sends)
```

## Conversation history

Conversations are saved in the browser's `localStorage` (key `rag_conversations`) by
`useConversations.js` — they survive refresh and browser restart, per-browser. This is the
interim solution; server-side persistent history will come with Entra ID + cloud (Phase 5/6).

## Architecture principle

One responsibility per file:
- **State & logic** live in `hooks/useConversations.js`.
- **Server communication** lives in `api/chatApi.js`.
- **UI** lives in `components/` — each component renders one thing.
- `App.jsx` only composes; it holds no state and no fetch calls.

To change the backend URL, edit `api/chatApi.js` only. To restyle a bubble, edit
`MessageBubble.jsx` / `index.css` only.

## Running

```powershell
npm install        # first time only
npm run dev        # dev server with hot-reload at http://localhost:5173
```

Vite hot-reloads on save — no manual restart needed for UI changes. The backend must be
running on port 8000 for questions to work.

## Conventions

- Plain JavaScript only. Do not introduce TypeScript or Next.js.
- Hebrew UI text, RTL layout (`dir="rtl"` in `index.html`).
- Keep components small and presentational; put shared logic in hooks.