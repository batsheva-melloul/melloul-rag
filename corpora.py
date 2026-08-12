"""
Corpora configuration — the single source of truth for the chatbots.

Each corpus is one document repository that becomes one isolated chatbot,
answering ONLY from its own documents.

To add a chatbot: add one entry here (and later, sync its SharePoint site).
    id        - short unique key (letters/digits/underscores); names its collection
    name      - display name shown in the UI
    site_path - SharePoint site path to sync from (e.g. "sites/MAGAR")
    role      - Entra App Role required to access it (Part B). None = open to all.
"""

CORPORA = [
    {
        "id": "magar",
        "name": "מאגר פילוסופיה",
        "site_path": "sites/MAGAR",
        # Sync ONLY this subfolder of the site's document library (the OCR'd
        # books with a real text layer). Omit "folder" to sync the whole library.
        "folder": "ספרים OCR",
        "role": "magar",  # only users assigned the "magar" App Role can access
    },
    {
        "id": "misim",
        "name": "מאגר מיסים",
        "site_path": "sites/MagarMIsim",
        "role": "misim",  # only users assigned the "misim" App Role can access
    },
    {
        # Example empty corpus — appears in the UI as a third chatbot.
        # It has no documents until its SharePoint site is synced.
        "id": "demo",
        "name": "מאגר לדוגמה (ריק)",
        "site_path": "sites/Demo",
        "role": None,
    },
]


def all_corpora() -> list[dict]:
    """Return the full list of configured corpora."""
    return CORPORA


def get_corpus(corpus_id: str) -> dict | None:
    """Return the corpus with this id, or None if it doesn't exist."""
    for corpus in CORPORA:
        if corpus["id"] == corpus_id:
            return corpus
    return None