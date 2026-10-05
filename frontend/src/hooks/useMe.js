import { useState, useEffect } from "react";
import { useMsal } from "@azure/msal-react";
import { fetchMe } from "../api/chatApi";
import { getAccessToken } from "../auth/getToken";

// Who is signed in, according to the BACKEND (name, email, isAdmin). The admin
// flag comes from the server (App Role or ADMIN_USERS) — the UI only uses it
// to show or hide the admin button; every admin endpoint re-checks it.
export function useMe() {
  const { instance, accounts } = useMsal();
  const [me, setMe] = useState({ name: "", email: "", isAdmin: false });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getAccessToken(instance, accounts);
        const data = await fetchMe(token);
        if (!cancelled) setMe(data);
      } catch {
        // Not fatal: the chat works without it; admin button stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return me;
}
