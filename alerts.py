"""
Email alerts — currently for the nightly SharePoint sync (a failure at 03:00
is invisible unless someone is told; it once went unnoticed for three weeks).

Mail is sent through Microsoft Graph with the SAME app-only credentials the
SharePoint sync already uses (AZURE_TENANT_ID / AZURE_CLIENT_ID /
AZURE_CLIENT_SECRET). That needs ONE extra permission on the app registration
in Entra: `Mail.Send` (Application), with admin consent. Ask IT to also limit it
to the sending mailbox with an Exchange application access policy
(New-ApplicationAccessPolicy), so the app cannot send as anyone else.

Environment:
    ALERT_EMAIL_TO    comma-separated recipients. Unset / empty = alerts OFF.
    ALERT_EMAIL_FROM  mailbox to send as (default: the first recipient).
    APP_URL           optional; linked at the bottom of the mail (the admin page).

Never raises: a failed alert is logged and swallowed, so it can never break the
sync it reports on.

Check the configuration / send one real test mail from a terminal:
    python alerts.py          (shows whether alerts are on, and to whom)
    python alerts.py test     (sends a test mail — proves the permission works)
"""

import os
import logging
import datetime

import httpx

logger = logging.getLogger("rag.alerts")

GRAPH = "https://graph.microsoft.com/v1.0"


def recipients() -> list[str]:
    return [a.strip() for a in os.getenv("ALERT_EMAIL_TO", "").split(",") if a.strip()]


def sender() -> str | None:
    to = recipients()
    return os.getenv("ALERT_EMAIL_FROM") or (to[0] if to else None)


def enabled() -> bool:
    return bool(recipients()) and bool(sender())


def send_email(subject: str, text: str) -> bool:
    """Send one plain-text mail to ALERT_EMAIL_TO. Returns True when it went out."""
    if not enabled():
        logger.info("alert not sent (ALERT_EMAIL_TO is not set): %s", subject)
        return False
    try:
        # The app-only Graph token the SharePoint sync uses (importing sharepoint
        # also applies the corporate-network SSL patch to httpx, via llm).
        import sharepoint
        token = sharepoint.get_valid_token()
        payload = {
            "message": {
                "subject": subject,
                "body": {"contentType": "Text", "content": text},
                "toRecipients": [{"emailAddress": {"address": a}} for a in recipients()],
            },
            "saveToSentItems": False,
        }
        response = httpx.post(
            f"{GRAPH}/users/{sender()}/sendMail",
            headers={"Authorization": f"Bearer {token}"},
            json=payload, timeout=30,
        )
        response.raise_for_status()
        logger.info("alert sent to %s: %s", recipients(), subject)
        return True
    except httpx.HTTPStatusError as error:
        hint = ""
        if error.response.status_code in (401, 403):
            hint = " — the app registration probably lacks the Mail.Send (Application) permission"
        logger.warning("alert NOT sent (HTTP %s%s): %s",
                       error.response.status_code, hint, error.response.text[:300])
        return False
    except Exception as error:
        logger.warning("alert NOT sent (%s: %s)", type(error).__name__, error)
        return False


# ---------------------------------------------------------------------------
# The alerts themselves
# ---------------------------------------------------------------------------

def notify_sync_failures(failures: list[dict], when: datetime.datetime | None = None) -> None:
    """
    One mail for a scheduled sync in which one or more corpora failed.
    failures: [{"corpus": display name, "id": corpus id, "error": str}, ...]
    """
    if not failures:
        return
    when = when or datetime.datetime.now()
    ids = ", ".join(f["id"] for f in failures)
    subject = f"⚠️ עוזר החברה: הסנכרון הלילי נכשל ({ids})"
    lines = [f"הסנכרון האוטומטי של {when:%d/%m/%Y %H:%M} נכשל עבור {len(failures)} מאגר(ים):", ""]
    for f in failures:
        lines += [f"• {f['corpus']} ({f['id']})", f"  {str(f['error'])[:400]}", ""]
    lines += [
        "סיבות נפוצות:",
        "- 404 Not Found: תיקייה או אתר ב-SharePoint שונו שם או הוזזו (השם המוגדר נמצא ב-corpora.py).",
        "- 401 / 403: הרשאות האפליקציה ב-Entra השתנו.",
        "- timeout: SharePoint או הרשת לא היו זמינים; ינסה שוב מחר באותה שעה.",
        "",
    ]
    url = os.getenv("APP_URL")
    if url:
        lines.append(f"עמוד הניהול: {url}")
    send_email(subject, "\n".join(lines))


def notify_sync_skipped(reason: str) -> None:
    """One mail when the scheduled sync did not run at all."""
    send_email(
        "⚠️ עוזר החברה: הסנכרון הלילי לא רץ",
        f"הסנכרון האוטומטי לא רץ הלילה.\nסיבה: {reason}\n\n"
        "הוא ינסה שוב מחר באותה שעה. אפשר להריץ ידנית מעמוד הניהול (\"סנכרן עכשיו\").",
    )


if __name__ == "__main__":
    import sys
    from dotenv import load_dotenv
    load_dotenv()
    print(f"alerts enabled: {enabled()}")
    print(f"to:   {recipients() or '-'}")
    print(f"from: {sender() or '-'}")
    if len(sys.argv) > 1 and sys.argv[1] == "test":
        logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
        ok = send_email(
            "✅ עוזר החברה: בדיקת התראות",
            "זהו מייל בדיקה. אם הגיע — ההתראות על הסנכרון הלילי מוגדרות נכון.",
        )
        print("test mail sent:", ok)
