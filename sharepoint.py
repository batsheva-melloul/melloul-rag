"""
SharePoint document sync via Microsoft Graph (app-only / client credentials).

Streams every PDF from a SharePoint site's document library straight into the
vector store — the PDFs are processed IN MEMORY and never saved to disk; only
the resulting vectors persist in Chroma.

Optimization: each file's SharePoint change-tag (cTag) is stored alongside its
vectors. On the next sync, unchanged files are skipped WITHOUT being downloaded.

The app authenticates AS ITSELF (application permission Sites.Read.All), not as
the signed-in user.

Each corpus's SharePoint site_path is defined in corpora.py (one per chatbot).

Required environment variables (in .env):
    AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
    SHAREPOINT_HOSTNAME    - e.g. melloulil.sharepoint.com

Run:  python sharepoint.py            (sync all corpora)
      python sharepoint.py magar      (sync only one corpus)
"""

import os
import time
import logging
import httpx
from dotenv import load_dotenv

# Importing llm applies the httpx SSL-verification patch needed on the
# corporate network (SSL inspection).
import llm  # noqa: F401
from rag_core import RagEngine

logger = logging.getLogger("rag.sharepoint")

GRAPH = "https://graph.microsoft.com/v1.0"


def get_app_token() -> str:
    """Get an app-only access token for Microsoft Graph (client credentials flow)."""
    tenant = os.environ["AZURE_TENANT_ID"]
    response = httpx.post(
        f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
        data={
            "client_id": os.environ["AZURE_CLIENT_ID"],
            "client_secret": os.environ["AZURE_CLIENT_SECRET"],
            "scope": "https://graph.microsoft.com/.default",
            "grant_type": "client_credentials",
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()["access_token"]


# Cached token that refreshes itself. A large sync can run longer than a single
# token's ~60-min lifetime, so we refresh proactively (well before expiry) to
# avoid mid-sync 401s.
_token = {"value": None, "expires": 0.0}


def get_valid_token(force: bool = False) -> str:
    """Return a valid Graph token, refreshing it if stale (or if force=True)."""
    now = time.time()
    if force or _token["value"] is None or now >= _token["expires"]:
        _token["value"] = get_app_token()
        _token["expires"] = now + 45 * 60  # refresh at 45 min (tokens last ~60)
    return _token["value"]


def get_site_id(token: str, hostname: str, site_path: str) -> str:
    """Resolve a SharePoint site's Graph ID from its hostname and path."""
    url = f"{GRAPH}/sites/{hostname}:/{site_path}"
    response = httpx.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)
    response.raise_for_status()
    return response.json()["id"]


def list_pdf_items(token: str, site_id: str, folder: str | None = None) -> list[dict]:
    """
    Walk the site's document library and return all PDF items, each with its
    name, id, and cTag (the change-tag we use to detect modifications).

    If `folder` is given (e.g. "ספרים OCR"), only that subfolder is walked
    (recursively); otherwise the whole library is walked from its root.
    """
    headers = {"Authorization": f"Bearer {token}"}
    pdfs: list[dict] = []

    def walk(item_id: str):
        url = f"{GRAPH}/sites/{site_id}/drive/items/{item_id}/children"
        response = httpx.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        for item in response.json().get("value", []):
            if "folder" in item:
                walk(item["id"])  # recurse into subfolders
            elif item["name"].lower().endswith(".pdf"):
                pdfs.append({
                    "id": item["id"],
                    "name": item["name"],
                    "cTag": item.get("cTag", ""),  # changes when content changes
                })

    if folder:
        # Resolve the subfolder's item id by its path under the library root.
        url = f"{GRAPH}/sites/{site_id}/drive/root:/{folder}"
        response = httpx.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        walk(response.json()["id"])
    else:
        walk("root")
    return pdfs


def download_bytes(token: str, site_id: str, item_id: str) -> bytes:
    """
    Download one drive item's content into memory (no file on disk).
    Large OCR'd books can be slow (esp. over the SSL-inspected corporate
    network), so we use a generous timeout and retry on network errors.
    """
    url = f"{GRAPH}/sites/{site_id}/drive/items/{item_id}/content"
    max_attempts = 4
    for attempt in range(1, max_attempts + 1):
        try:
            response = httpx.get(
                url,
                headers={"Authorization": f"Bearer {token}"},
                follow_redirects=True,  # Graph redirects to a temporary download URL
                timeout=300,            # big files over a slow/inspected link
            )
            response.raise_for_status()
            return response.content
        except httpx.TransportError as error:
            # Timeout / connection reset while downloading — retry.
            if attempt < max_attempts:
                wait = 10 * attempt
                logger.warning("Download network error (%s); retry %d/%d in %ds",
                               type(error).__name__, attempt, max_attempts, wait)
                time.sleep(wait)
                continue
            raise


def sync_corpus(hostname: str, corpus: dict, engine: RagEngine) -> dict:
    """
    Sync ONE corpus: download + embed only NEW or CHANGED files from its
    SharePoint site into that corpus's collection. Returns a small summary.
    The Graph token is refreshed automatically so long syncs don't hit 401s.
    """
    site_path = corpus["site_path"]
    logger.info("=== Corpus '%s' (%s) — site %s/%s ===",
                corpus["id"], corpus["name"], hostname, site_path)
    site_id = get_site_id(get_valid_token(), hostname, site_path)

    items = list_pdf_items(get_valid_token(), site_id, corpus.get("folder"))
    logger.info("Found %d PDF file(s)%s", len(items),
                f" in folder '{corpus['folder']}'" if corpus.get("folder") else "")

    indexed, skipped = 0, 0
    for item in items:
        source = item["name"]
        version = item["cTag"]

        # Skip unchanged files WITHOUT downloading them (lets a re-run resume).
        if engine.is_current(source, version):
            logger.info("[%s] unchanged — skipping (no download)", source)
            skipped += 1
            continue

        logger.info("[%s] downloading + indexing...", source)
        try:
            data = download_bytes(get_valid_token(), site_id, item["id"])
        except httpx.HTTPStatusError as error:
            # A stale token slipped through — force a refresh and retry once.
            if error.response.status_code == 401:
                data = download_bytes(get_valid_token(force=True), site_id, item["id"])
            else:
                raise
        engine.index_bytes(source, version, data)
        indexed += 1

    summary = {"total": len(items), "indexed": indexed, "skipped": skipped}
    logger.info("Corpus '%s' done: %s", corpus["id"], summary)
    return summary


def sync_all(only_corpus_id: str | None = None) -> dict:
    """
    Sync every configured corpus (or just one, if only_corpus_id is given).
    Each corpus goes into its own isolated collection.
    """
    from corpora import all_corpora, get_corpus

    load_dotenv()
    hostname = os.environ["SHAREPOINT_HOSTNAME"]

    logger.info("Authenticating to Microsoft Graph...")
    get_valid_token()  # warm up + validate credentials early

    if only_corpus_id:
        corpus = get_corpus(only_corpus_id)
        if corpus is None:
            raise ValueError(f"Unknown corpus: {only_corpus_id}")
        corpora = [corpus]
    else:
        corpora = all_corpora()

    results = {}
    for corpus in corpora:
        engine = RagEngine(corpus["id"])
        results[corpus["id"]] = sync_corpus(hostname, corpus, engine)

    logger.info("All corpora done: %s", results)
    return results


if __name__ == "__main__":
    import sys
    from log_config import setup_logging
    setup_logging()
    # Optional argument: sync only one corpus by id. Otherwise sync all.
    target = sys.argv[1] if len(sys.argv) > 1 else None
    sync_all(target)