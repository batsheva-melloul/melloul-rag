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

# All corpora live in ONE SharePoint site (sites/MAGAR) since 2026-11-15, one
# top-level folder each ("מאגר מידע - <subject>"). The old per-corpus site
# sites/MagarMIsim is empty and no longer used.
#
# "folder" = sync ONLY that subfolder of the site's document library; omit it to
# sync the whole library. Folder names are matched EXACTLY, so a rename in
# SharePoint breaks the nightly sync with a 404 (happened 2026-10-14 and again
# 2026-11-15) — when that happens, update the name here.
CORPORA = [
    {
        "id": "magar",
        "name": "מאגר פילוסופיה",
        "site_path": "sites/MAGAR",
        # The OCR'd books (real text layer). The sibling folder without "OCR"
        # holds scanned originals that pypdf cannot read — not synced on purpose.
        "folder": "מאגר מידע - פילוסופיה OCR",
        "role": "magar",  # only users assigned the "magar" App Role can access
    },
    {
        "id": "misim",
        "name": "מאגר מיסים",
        "site_path": "sites/MAGAR",
        "folder": "מאגר מידע - מיסים",
        "role": "misim",  # only users assigned the "misim" App Role can access
    },
    {
        "id": "avoda",
        "name": "מאגר דיני עבודה וביטוח לאומי",
        "site_path": "sites/MAGAR",
        "folder": "מאגר מידע - דיני עבודה וביטוח לאומי",
        # Needs an "avoda" App Role on the app registration (Entra) assigned to
        # the users who may read it. Set to None to open it to everyone signed in.
        "role": "avoda",
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