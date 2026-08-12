import { DEMO_MODE } from "../config";
import { apiRequest } from "./msalConfig";

// Get an access token for our backend API.
// In demo mode there is no sign-in, so we return an empty string.
// Otherwise: try silently first, then fall back to a popup.
export async function getAccessToken(instance, accounts) {
  if (DEMO_MODE) return "";
  const account = accounts[0];
  try {
    const result = await instance.acquireTokenSilent({ ...apiRequest, account });
    return result.accessToken;
  } catch (error) {
    const result = await instance.acquireTokenPopup(apiRequest);
    return result.accessToken;
  }
}