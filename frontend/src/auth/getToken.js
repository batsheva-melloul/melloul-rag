import { InteractionRequiredAuthError } from "@azure/msal-browser";
import { DEMO_MODE } from "../config";
import { apiRequest, loginRequest } from "./msalConfig";

// Get an access token for our backend API.
//
// Entra gives a SPA a refresh token that lives only 24 hours. After that MSAL
// must renew through a hidden iframe to login.microsoftonline.com, which
// third-party-cookie blocking and corporate SSL inspection routinely break.
// When that happens the renewal legitimately needs user interaction.
//
// We NEVER use a popup for that interaction:
//   - the popup's redirect URI is our own origin, so the whole chat app booted
//     inside the small popup window ("the chat opens in a tiny login window");
//   - popup blockers and the corporate proxy can leave it hanging, and MSAL
//     then records "interaction in progress" and refuses every later attempt,
//     which is why wiping MSAL's storage by hand was the only way out.
// Instead we do a full-page redirect, exactly like the initial sign-in (which
// is the one flow known to work on this network). The caller can save its
// pending work before the page unloads by catching RedirectingError.
//
// Other rules:
//   1. Use the ACTIVE account, never accounts[0] (which can be a stale entry
//      whose silent renewal fails forever).
//   2. Share one in-flight request between concurrent callers, so the hooks
//      that load at startup never start three interactions at once.
//   3. Only go interactive on InteractionRequiredAuthError. A network blip
//      must surface as an error, not as a redirect that cannot fix it.

// Thrown when we have started a full-page redirect. Nothing after it runs on
// this page, but callers can use it to stash state before the unload.
export class RedirectingError extends Error {
  constructor() {
    super("Redirecting for sign-in");
    this.name = "RedirectingError";
  }
}

// MSAL keeps its "interaction in progress" flag in sessionStorage. If a
// previous interaction died half-way (closed popup, killed tab, proxy error)
// the flag survives and every later interactive call throws
// interaction_in_progress. Clearing it is safe: no interaction is actually
// running on a freshly loaded page that is about to redirect anyway.
function clearStaleInteractionFlag() {
  try {
    sessionStorage.removeItem("msal.interaction.status");
  } catch {
    // Storage unavailable — nothing to clear.
  }
}

// Shared promise for the current token request. Concurrent callers await this
// same promise instead of each starting their own interactive flow.
let inFlight = null;

export async function getAccessToken(instance, accounts) {
  if (DEMO_MODE) return "";
  if (!inFlight) {
    inFlight = requestToken(instance, accounts).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function requestToken(instance, accounts) {
  // The active account is the one MSAL actually signed in. Fall back to the
  // list only when no active account has been set yet (first load).
  const account = instance.getActiveAccount() || accounts[0] || null;

  // No account at all: the cache is empty or unusable. Sign in from scratch.
  if (!account) {
    await redirect(instance, () => instance.loginRedirect(loginRequest));
    throw new RedirectingError();
  }

  try {
    const result = await instance.acquireTokenSilent({ ...apiRequest, account });
    // Keep the active account in step with whatever MSAL just used, so the
    // next call cannot drift back to a stale entry.
    if (result.account) instance.setActiveAccount(result.account);
    return result.accessToken;
  } catch (error) {
    if (!needsInteraction(error) || redirectedRecently()) {
      // Interaction would not help (or we just tried it). Let the caller
      // show its normal "could not reach the server" message.
      console.error("Token renewal failed", error);
      throw error;
    }
    // Pass the account so there is no account picker and the new token lands
    // on the account we asked about.
    await redirect(instance, () =>
      instance.acquireTokenRedirect({ ...apiRequest, account })
    );
    throw new RedirectingError();
  }
}

// Decide whether a failed silent renewal should send the user through the
// sign-in page. Besides the explicit "interaction_required" answers from
// Entra, the hidden-iframe renewal can hang, come back empty or trip over the
// app booting inside the iframe on this network (proxy / SSL inspection /
// blocked third-party cookies). MSAL reports those under many different
// generic codes, so instead of listing them we treat EVERY silent failure as
// needing a sign-in, except the few that a sign-in cannot fix:
//   - the token endpoint was unreachable (a genuine network outage)
//   - the user cancelled
// A sign-in redirect is cheap when the Microsoft session cookie is still
// valid (it bounces straight back and the question is resent), and the loop
// guard below stops us from redirecting forever if it keeps failing.
const NON_INTERACTIVE_CODES = new Set([
  "post_request_failed",
  "no_network_connectivity",
  "user_cancelled",
]);

function needsInteraction(error) {
  if (error instanceof InteractionRequiredAuthError) return true;
  return !NON_INTERACTIVE_CODES.has(error?.errorCode || "");
}

// Loop guard: if we already redirected for sign-in very recently and the
// silent renewal STILL fails, something else is wrong (Entra config, backend
// scope). Surface the error instead of bouncing to Microsoft again and again.
const REDIRECT_STAMP_KEY = "rag_last_auth_redirect";
const REDIRECT_COOLDOWN_MS = 60 * 1000;

function redirectedRecently() {
  try {
    const stamp = Number(sessionStorage.getItem(REDIRECT_STAMP_KEY) || 0);
    return Date.now() - stamp < REDIRECT_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function stampRedirect() {
  try {
    sessionStorage.setItem(REDIRECT_STAMP_KEY, String(Date.now()));
  } catch {
    // Storage unavailable — no guard, but also nothing to loop on.
  }
}

// Start a redirect, recovering from the two ways it can be refused:
//   - interaction_in_progress: a stale flag from a dead interaction. Clear it
//     and try once more.
//   - anything else: the token cache itself is unusable. Wipe it and start a
//     clean sign-in — what the user previously had to do by hand.
async function redirect(instance, start) {
  stampRedirect();
  try {
    await start();
    return;
  } catch (error) {
    if (error?.errorCode === "interaction_in_progress") {
      clearStaleInteractionFlag();
      try {
        await start();
        return;
      } catch {
        // Fall through to the full reset below.
      }
    }
  }
  clearStaleInteractionFlag();
  await instance.clearCache();
  await instance.loginRedirect(loginRequest);
}
