"""
test_azure.py — one-off connectivity check for the Azure OpenAI resource.

Answers three questions, using ONLY the endpoint + api-key from .env:
  1. Do the credentials work at all?
  2. Which model DEPLOYMENTS already exist (and what are their names)?
  3. Does this region support gpt-4o-mini / text-embedding-3-small?

It never creates anything — read-only probing. Run:
    python test_azure.py
"""

import os
import sys
import json

# Hebrew prints correctly on the Windows console.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import httpx
from dotenv import load_dotenv

load_dotenv()

ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT", "").rstrip("/")
API_KEY = os.getenv("AZURE_OPENAI_API_KEY", "")
API_VERSION = os.getenv("AZURE_OPENAI_API_VERSION", "2024-10-21")
CHAT_DEP = os.getenv("AZURE_OPENAI_CHAT_DEPLOYMENT", "gpt-4o-mini")
EMBED_DEP = os.getenv("AZURE_OPENAI_EMBED_DEPLOYMENT", "text-embedding-3-small")

# Corporate network does SSL inspection — mirror the app's behavior.
VERIFY = os.getenv("DISABLE_SSL_VERIFY", "false").lower() != "true"
if not VERIFY:
    import urllib3
    urllib3.disable_warnings()

HEADERS = {"api-key": API_KEY, "Content-Type": "application/json"}


def check_config() -> bool:
    if not ENDPOINT or not API_KEY or API_KEY == "PASTE_KEY1_HERE":
        print("❌ חסר ENDPOINT או API_KEY ב-.env (הדביקי את key1 ב-AZURE_OPENAI_API_KEY).")
        return False
    print(f"Endpoint : {ENDPOINT}")
    print(f"Key      : ...{API_KEY[-4:]} (מוסתר)")
    print(f"Version  : {API_VERSION}\n")
    return True


def get(path: str):
    url = f"{ENDPOINT}{path}"
    return httpx.get(url, headers=HEADERS, verify=VERIFY, timeout=30)


def post(path: str, body: dict):
    url = f"{ENDPOINT}{path}"
    return httpx.post(url, headers=HEADERS, json=body, verify=VERIFY, timeout=30)


def list_deployments():
    print("── 1) פריסות קיימות (Deployments) " + "─" * 25)
    try:
        r = get(f"/openai/deployments?api-version={API_VERSION}")
    except Exception as e:
        print(f"   שגיאת רשת: {type(e).__name__}: {e}\n")
        return
    if r.status_code != 200:
        print(f"   לא ניתן לרשום פריסות (HTTP {r.status_code}). "
              f"ייתכן שאין הרשאת ניהול — נבדוק ישירות למטה.\n")
        return
    data = r.json().get("data", r.json())
    if not data:
        print("   אין פריסות כלל — צריך ליצור אותן (תרחיש ב').\n")
        return
    for d in data:
        name = d.get("id") or d.get("name")
        model = (d.get("model") or d.get("properties", {}).get("model"))
        print(f"   ✓ פריסה: '{name}'  →  מודל: {model}")
    print()


def list_models():
    print("── 2) כל המודלים שהאזור תומך בהם " + "─" * 25)
    try:
        r = get(f"/openai/models?api-version={API_VERSION}")
    except Exception as e:
        print(f"   שגיאת רשת: {type(e).__name__}: {e}\n")
        return
    if r.status_code != 200:
        print(f"   HTTP {r.status_code}: {r.text[:200]}\n")
        return

    chat, embed = [], []
    for m in r.json().get("data", []):
        mid = m.get("id", "")
        caps = m.get("capabilities", {}) or {}
        status = m.get("lifecycle_status", m.get("status", ""))
        if caps.get("chat_completion"):
            chat.append((mid, status))
        if caps.get("embeddings"):
            embed.append((mid, status))

    print("   >> מודלי צ'אט זמינים:")
    for mid, status in sorted(chat):
        print(f"        {mid:34} [{status}]")
    if not chat:
        print("        (אין)")
    print("   >> מודלי embeddings זמינים:")
    for mid, status in sorted(embed):
        print(f"        {mid:34} [{status}]")
    if not embed:
        print("        (אין)")
    print()


def probe(kind: str, deployment: str, path: str, body: dict):
    try:
        r = post(f"/openai/deployments/{deployment}/{path}?api-version={API_VERSION}", body)
    except Exception as e:
        print(f"   {kind:10} '{deployment}': שגיאת רשת {type(e).__name__}")
        return
    if r.status_code == 200:
        print(f"   {kind:10} '{deployment}': ✓ עובד!")
    elif r.status_code == 404:
        print(f"   {kind:10} '{deployment}': ✗ פריסה בשם הזה לא קיימת (404)")
    else:
        msg = r.text[:160].replace("\n", " ")
        print(f"   {kind:10} '{deployment}': HTTP {r.status_code} — {msg}")


def probe_deployments():
    print("── 3) בדיקה ישירה של שמות הפריסות מ-.env " + "─" * 16)
    # gpt-5 family uses max_completion_tokens (not max_tokens).
    probe("chat", CHAT_DEP, "chat/completions",
          {"messages": [{"role": "user", "content": "ping"}], "max_completion_tokens": 16})
    probe("embed", EMBED_DEP, "embeddings", {"input": "ping"})
    print()


def main():
    print("\n=== בדיקת Azure OpenAI ===\n")
    if not check_config():
        return
    list_deployments()
    list_models()
    probe_deployments()
    print("=" * 60)
    print("סיכום: אם ראית '✓ עובד!' בשלב 3 — הפריסות קיימות ואפשר להתחבר.")
    print("אם ראית 404 — הפריסות עוד לא נוצרו וצריך ליצור אותן.")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()
