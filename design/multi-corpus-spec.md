# Multi-Corpus Chatbots — Design Spec

## Goal
Turn the single chatbot into **several chatbots**, each responsible for ONE document
repository ("corpus") and answering ONLY from it. Later, restrict each corpus to its
authorized users.

## Key principle
Each corpus = its own **Chroma collection**. Isolation is structural: a query against
corpus A physically cannot return results from corpus B.

## Infrastructure (unchanged count)
- **1** Frontend, **1** Backend, **1** server, **1** Chroma store.
- Multiple corpora = multiple *collections* inside the one Chroma store + config.
- The multiplicity is logical (data/config), not infrastructural.

```
browser → (corpus_id) → one Backend → that corpus's collection → answer
```

---

## Part A — Multi-corpus (no permissions yet; testable in demo mode)

### A1. Corpora config  (code)
`corpora.py` — single source of truth:
```python
CORPORA = [
  { "id": "magar", "name": "מאגר מידע ספרי", "site_path": "sites/MAGAR", "role": None },
  ...
]
```
Adding a corpus = adding one entry.

### A2. Core  (code)
- `collection_name(corpus_id, embed_model)` → a distinct collection per corpus.
- `RagEngine(corpus_id, docs_dir=None)` → bound to one corpus's collection.
- `build_registry()` → dict `corpus_id → RagEngine`, built once at startup.

### A3. Backend  (code)
- `GET /corpora` → list of `{id, name}` for the UI.
- `POST /ask` → add `corpus_id`; route to the right engine (404 if unknown).

### A4. Frontend  (code)
- Load `/corpora` → a corpus picker (cards / dropdown).
- Send `corpus_id` with each question.
- Conversations tagged with their `corpusId`; sidebar filtered by the selected corpus.

### A5. SharePoint sync  (code)
- `python sharepoint.py` loops over corpora; each syncs its `site_path` into its collection.

---

## Part B — Per-corpus permissions (real auth, login required)

### B1. Azure App Roles  (Azure — user/IT)
- Define one App Role per corpus (`magar`, `hr`, `legal` ...).
- Assign users/groups to roles (can map to existing Entra/SharePoint groups).

### B2. Config  (code)
- Each corpus gets its allowed `role` (e.g. `"hr"`). `None` = open to all.

### B3. Auth  (code)
- `auth.py` extracts the `roles` claim from the validated token + a check helper.

### B4. Backend  (code)
- `GET /corpora` returns ONLY corpora the user has the role for.
- `POST /ask` verifies the user's role for the requested corpus → else 403.

### B5. Frontend  (code)
- Already restricted automatically (shows only what `/corpora` returns).
- Requires DEMO_MODE = off (permissions need the authenticated identity).

---

## Build order & testing
1. A1 + A2 — config + core (test: two corpora → isolated collections).
2. A3 — backend routing (test: two questions, two corpora, isolated answers).
3. A4 — frontend picker (test in demo mode: switch corpora).
4. A5 — per-corpus sync.
5. B1–B4 — permissions (turn demo off; test: each user sees only allowed corpora).

Each step is independently testable before the next. Existing building blocks
(`llm.py`, `RagEngine`, JWT auth, demo mode) are reused, not replaced.

## Notes
- The current collection becomes the first corpus (MAGAR).
- Reuses app-only SharePoint access (the app can read restricted sites; the chatbot
  layer gates who can *use* each corpus via roles).
