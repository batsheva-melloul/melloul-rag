// Configuration for MSAL — Microsoft's official sign-in library.
// These IDs are NOT secrets; they are safe to keep in client-side code.

export const msalConfig = {
  auth: {
    // The Application (client) ID of our Entra app registration (RAG-Test).
    clientId: "62ddfafb-ea62-4e6f-abaf-254af76b35d6",
    // "authority" = which organization users sign in against.
    // Using our tenant ID means ONLY melloul employees can sign in.
    authority:
      "https://login.microsoftonline.com/d3dda2aa-21d1-41c6-8bfc-edfdd80dcb83",
    // Where Microsoft sends the user back after sign-in — the current origin,
    // so it works both locally (http://localhost:5173) and in the cloud
    // (https://<app>.azurewebsites.net) with no code change. EACH origin must
    // be registered as a Redirect URI in the Entra app registration.
    redirectUri: window.location.origin,
    // Where to return after sign-OUT (back to our app's login screen).
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    // Keep the session in localStorage so a refresh doesn't log the user out.
    cacheLocation: "localStorage",
    storeAuthStateInCookie: false,
  },
};

// The permissions we request at sign-in. "User.Read" lets us read the
// signed-in user's basic profile (name, email). These are user-consentable —
// no admin approval needed.
export const loginRequest = {
  scopes: ["User.Read"],
};

// The scope for OUR backend API. Requesting it gives us an access token whose
// audience is our server, which the backend then validates.
export const apiRequest = {
  scopes: ["api://62ddfafb-ea62-4e6f-abaf-254af76b35d6/access_as_user"],
};