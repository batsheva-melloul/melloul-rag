# Sign-in & token renewal (Entra ID + MSAL)

How the chat authenticates users, how tokens are renewed, why it used to get
stuck in a small popup window, and how to test the recovery paths.

## Components

| Where | What |
|---|---|
| `frontend/src/auth/msalConfig.js` | Entra app registration IDs, `loginRequest` (User.Read), `apiRequest` (our API scope). Not secrets. |
| `frontend/src/main.jsx` | Creates the MSAL instance, sets the active account, wraps the app in `MsalProvider`. |
| `frontend/src/App.jsx` (`AuthGate`) | Shows a spinner while MSAL is mid-interaction, then the chat or the login screen. |
| `frontend/src/components/LoginScreen.jsx` | "Sign in with Microsoft" button: `loginRedirect`. |
| `frontend/src/auth/getToken.js` | **The only place that acquires an API token.** All hooks call `getAccessToken(instance, accounts)`. |
| `frontend/src/auth/pendingQuestion.js` | Parks a question across a sign-in redirect so it is resent automatically. |
| `backend/auth.py` | Validates the JWT on every API call (`Depends(verify_token)`). |

Redirect URI is `window.location.origin`, so the same code works on localhost
and in the cloud. Every origin must be registered on the Entra app registration.

## Normal flow

1. First visit: login screen, `loginRedirect` to Microsoft, back to the app.
   MSAL stores the account + tokens in `localStorage`.
2. Every API call: `getAccessToken` calls `acquireTokenSilent`. That returns the
   cached access token, or renews it with the refresh token, or (when both are
   gone) through a hidden iframe to `login.microsoftonline.com` that relies on
   the Microsoft session cookie.
3. Entra gives single-page apps a refresh token that lives **24 hours**. After
   that, step 2 falls back to the hidden iframe.

## The bug that was fixed (Sept 2026)

On the corporate network the hidden-iframe renewal often fails: third-party
cookies blocked, SSL inspection, or the iframe simply times out. That is
legitimate and expected; the fix is a real sign-in. The old code handled it
with `acquireTokenPopup`, which caused the "stuck in a small window" symptom:

- The popup's redirect URI is our own origin, so the **whole chat app booted
  inside the popup**.
- Popup blockers / the proxy could leave the popup hanging. MSAL then records
  `msal.interaction.status` in `sessionStorage` and refuses every later
  interactive call with `interaction_in_progress`.
- Three hooks (`useCorpora`, `useBooks`, `useConversations`) each requested a
  token at startup, so several popups could open at once.
- Only wiping MSAL's storage by hand and signing in again recovered.

## Current behaviour of `getToken.js`

1. **One in-flight request** shared by all concurrent callers.
2. Uses the **active account**, never a stale `accounts[0]`.
3. `acquireTokenSilent` first. On success, the active account is refreshed.
4. If it fails and the error is anything other than a genuine network outage
   (`post_request_failed`, `no_network_connectivity`) or `user_cancelled`,
   it does **`acquireTokenRedirect`**: a full-page redirect, never a popup.
   With a valid Microsoft session cookie this bounces straight back with no
   prompt; otherwise the user sees the real Microsoft sign-in page.
5. If the redirect itself is refused with `interaction_in_progress`, the stale
   `sessionStorage` flag is cleared and the redirect is retried once. If it is
   still refused, the cache is wiped (`clearCache`) and `loginRedirect` starts
   a clean sign-in, automating what the user used to do by hand.
6. **Loop guard:** if a redirect happened less than 60 s ago and silent
   renewal still fails, the error is thrown (and logged to the console as
   `Token renewal failed ...`) instead of redirecting forever.
7. Callers receive `RedirectingError` when a redirect has started.

## Keeping the user's question across the redirect

`useConversations.sendQuestion` appends the user bubble, then calls
`runQuestion`. If `getAccessToken` throws `RedirectingError`, the question
(conversation id, corpus, text, directive, books, template) is saved to
`sessionStorage` via `pendingQuestion.js`. After the redirect:

- `useCorpora` selects the parked question's corpus instead of the first one.
- `useConversations` (effect keyed on `corpusId`) takes the parked question,
  re-opens its conversation and calls `runQuestion` with the history up to
  (not including) the already-shown user bubble.

Result: the user sees at most a brief hop to Microsoft, then the answer.

## How to test

Open DevTools (F12) on the live site. Confirm the deployed JS bundle in the
Network tab matches the latest `npm run build` output.

**A. Force a silent renewal (should be invisible, or a brief hop):**
```js
Object.keys(localStorage).filter(k => /accesstoken|refreshtoken/i.test(k)).forEach(k => localStorage.removeItem(k));
```
Ask a question. Expect an answer, possibly after a quick redirect.

**B. Stale "interaction in progress" flag (used to be a hard stall):**
```js
sessionStorage.setItem("msal.interaction.status", JSON.stringify({clientId:"62ddfafb-ea62-4e6f-abaf-254af76b35d6", type:"signin"}));
```
plus the line from A. Ask a question. Expect a redirect and an answer.

**C. Fully expired session (closest to the real 24 h case):**
1. In another tab, sign out at https://login.microsoftonline.com.
2. Back in the chat tab (no refresh), run the line from A.
3. Ask a question. Expect the real Microsoft sign-in page, then return to the
   same conversation with the question answered automatically.

**D. Real case:** wait more than 24 h since the last sign-in and ask a question.

**Must never happen:** a small popup window; needing to clear storage by hand;
"אירעה שגיאה בחיבור לשרת" without a red `Token renewal failed` line in the
console.

## Known limitation / possible follow-up

The redirect URI is the app itself, so the hidden renewal iframe loads the full
React bundle. MSAL's guards (`blockReloadInHiddenIframes`, interaction-type
checks) keep it from misbehaving, but it is slower and noisier than needed.
The clean fix is a tiny blank page (e.g. `/auth.html`) registered as an extra
redirect URI in Entra and passed as `redirectUri` on silent requests. This
needs a change in the Entra portal, so it was left out for now.

## Deploying frontend changes

`npm run build` in `frontend/` (production serves `frontend/dist`, not `src`),
then "Deploy to Web App" from VS Code, wait 1-2 minutes for the app to restart,
then Ctrl+Shift+R in the browser.
