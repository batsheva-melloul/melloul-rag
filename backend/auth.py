"""
Token verification for the FastAPI backend.

Every protected request must carry a JWT (access token) issued by Microsoft Entra
for our app. This module verifies that token's signature, audience, issuer, and
expiry. It is wired into endpoints as a FastAPI dependency (Depends).
"""

import os
import logging
import jwt  # PyJWT
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

logger = logging.getLogger("rag.auth")

# DEMO_MODE bypasses authentication entirely — for quick local/LAN demos ONLY.
# Set DEMO_MODE=true in .env to enable. Keep it false/unset for real use.
DEMO_MODE = os.getenv("DEMO_MODE", "false").lower() == "true"

# --- Our Entra app identifiers ---
TENANT_ID = "d3dda2aa-21d1-41c6-8bfc-edfdd80dcb83"
CLIENT_ID = "62ddfafb-ea62-4e6f-abaf-254af76b35d6"

# A token is valid only if it was meant for OUR API. Microsoft may set the
# audience to either the bare client ID or the full "api://<client-id>" URI,
# so we accept both.
ACCEPTED_AUDIENCES = [CLIENT_ID, f"api://{CLIENT_ID}"]

# A token is valid only if it came from OUR tenant. v1 and v2 tokens use
# slightly different issuer URLs, so we accept both forms.
ACCEPTED_ISSUERS = [
    f"https://login.microsoftonline.com/{TENANT_ID}/v2.0",
    f"https://sts.windows.net/{TENANT_ID}/",
]

# Microsoft publishes the public keys used to sign tokens here. PyJWT's
# PyJWKClient downloads and caches them, and picks the right key per token.
JWKS_URL = f"https://login.microsoftonline.com/{TENANT_ID}/discovery/v2.0/keys"
_jwks_client = jwt.PyJWKClient(JWKS_URL)

# Reads the "Authorization: Bearer <token>" header.
# In demo mode the header is optional (auto_error=False) so requests without a
# token are allowed through.
_bearer_scheme = HTTPBearer(auto_error=not DEMO_MODE)


def verify_token(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
) -> dict:
    """
    Validate the incoming JWT and return its payload (the user's claims).
    Raises 401 if the token is missing, malformed, expired, or not trusted.
    In DEMO_MODE, skips all checks and returns a placeholder user.
    """
    if DEMO_MODE:
        return {"demo": True}

    token = credentials.credentials
    try:
        # Find the public key that matches this token's signature.
        signing_key = _jwks_client.get_signing_key_from_jwt(token)

        # Verify signature + audience + expiry in one step.
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=ACCEPTED_AUDIENCES,
        )
    except Exception as error:
        logger.warning("Rejected token (invalid): %s", error)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {error}",
        )

    # Verify the token came from our tenant.
    if payload.get("iss") not in ACCEPTED_ISSUERS:
        logger.warning("Rejected token (untrusted issuer): %s", payload.get("iss"))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Untrusted token issuer.",
        )

    return payload


def has_corpus_access(user: dict, corpus: dict) -> bool:
    """
    Decide whether the signed-in user may access a corpus.
    - corpus role None  -> open to everyone.
    - demo mode         -> everything is open.
    - otherwise         -> the user's token must carry that role.
    Entra puts assigned App Role values in the token's "roles" claim.
    """
    role = corpus.get("role")
    if role is None:
        return True
    if DEMO_MODE:
        return True
    return role in (user.get("roles") or [])