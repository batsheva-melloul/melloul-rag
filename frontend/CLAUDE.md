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
    ├── auth/
    │   ├── msalConfig.js       # Entra app IDs + scopes (not secrets)
    │   ├── getToken.js         # The ONLY place that acquires an API token (silent -> redirect, never popup)
    │   └── pendingQuestion.js  # Parks a question across a sign-in redirect so it is resent automatically
    ├── hooks/
    │   ├── useConversations.js  # All conversations, send logic, SERVER sync (+ localStorage cache)
    │   ├── useCorpora.js        # Loads /corpora, tracks the selected chatbot
    │   ├── useBooks.js          # Loads /books for the selected corpus
    │   └── useMe.js             # GET /me: name, email, isAdmin (shows the admin button)
    └── components/
        ├── Sidebar.jsx         # "New conversation" button + conversation list
        ├── ConversationItem.jsx# One row in the conversation list (title + delete)
        ├── ChatHeader.jsx      # Top bar: title, admin toggle (admins only), theme, logout
        ├── AdminPanel.jsx      # Admin page: KPI tiles, corpora + "sync now", question log
        ├── MessageList.jsx     # Scrollable list + auto-scroll to newest
        ├── MessageBubble.jsx   # One message (avatar + bubble)
        ├── SourceTags.jsx      # Citation pills (📄 source · page N)
        ├── TypingIndicator.jsx # Animated "..." while waiting
        ├── EmptyState.jsx      # Welcome screen before first question
        └── ChatInput.jsx       # Textarea + send button (Enter sends)
```

## Conversation history

Conversations live on the server, per signed-in user (`GET/PUT/DELETE /conversations`),
so the same history shows on every device. `useConversations.js` keeps a copy in
`localStorage` (key `rag_conversations`) as a cache: it renders instantly, then the
server list is merged in (newer `updatedAt` wins; cached conversations the server has
never seen are uploaded once). Changes are saved with a 1.2 s debounce; empty
conversations and ones whose answer is still streaming are not saved yet.

## Admin page

`App.jsx` switches the body between the chat and `AdminPanel` when `useMe()` says the
user is an admin (button in the header). The panel only reads `/admin/*`; the server
decides who is an admin (see backend/CLAUDE.md, `ADMIN_USERS`).

## Sign-in & tokens

Microsoft Entra ID via MSAL (`@azure/msal-browser` + `@azure/msal-react`). All token
acquisition goes through `auth/getToken.js`; never call `acquireToken*` elsewhere and
never use popups (they broke on the corporate network). Full description, recovery
logic and test recipes: `../design/auth-flow.md`.

## Streaming answers

`api/chatApi.js` -> `askQuestionStream` reads the SSE stream (`data: {json}` lines) from `POST /ask/stream`
and calls `onDelta(textSoFar)` as pieces arrive. `useConversations.runQuestion` adds a
bot bubble flagged `streaming: true` on the first delta, updates its text at most once
per animation frame, and on the final `done` event replaces it with the complete
message (sources, whole-book flag, template). While `streaming` is true,
`MessageBubble` renders plain Markdown (no quiz/slides/flashcards parsing of
half-written fences), hides the sources, and shows a blinking caret; `MessageList`
hides the "..." indicator once text is flowing.

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