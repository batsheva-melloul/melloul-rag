// Shared frontend configuration.

// DEMO_MODE skips Microsoft sign-in — for quick local/LAN demos only.
// Enable by putting VITE_DEMO_MODE=true in frontend/.env (then restart `npm run dev`).
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

// Where the backend API lives:
//  - DEV (Vite dev server on :5173): the backend is a separate process on :8000.
//  - PRODUCTION (bundled): FastAPI serves BOTH this page and the API from the
//    same origin, so we use a relative base ("") — no host/port needed.
export const API_BASE = import.meta.env.DEV
  ? `http://${window.location.hostname}:8000`
  : "";