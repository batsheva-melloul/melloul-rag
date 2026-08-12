import React from "react";
import ReactDOM from "react-dom/client";
import { PublicClientApplication, EventType } from "@azure/msal-browser";
import { MsalProvider } from "@azure/msal-react";
import App from "./App.jsx";
import { msalConfig } from "./auth/msalConfig";
import { DEMO_MODE } from "./config";
import "./index.css";

// Apply the saved (or system-preferred) color theme before React renders, so
// there's no light-mode flash on load. The header toggle updates it later.
const savedTheme = localStorage.getItem("rag_theme");
document.documentElement.dataset.theme =
  savedTheme ||
  (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");

const root = ReactDOM.createRoot(document.getElementById("root"));

if (DEMO_MODE) {
  // Demo mode: no sign-in at all. Do NOT create MSAL — it requires Web Crypto,
  // which is unavailable over plain http on a LAN IP and would crash the app.
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
} else {
  // Normal mode: set up Microsoft sign-in.
  const msalInstance = new PublicClientApplication(msalConfig);

  msalInstance.initialize().then(() => {
    const accounts = msalInstance.getAllAccounts();
    if (accounts.length > 0) {
      msalInstance.setActiveAccount(accounts[0]);
    }

    msalInstance.addEventCallback((event) => {
      if (event.eventType === EventType.LOGIN_SUCCESS && event.payload.account) {
        msalInstance.setActiveAccount(event.payload.account);
      }
    });

    root.render(
      <React.StrictMode>
        <MsalProvider instance={msalInstance}>
          <App />
        </MsalProvider>
      </React.StrictMode>
    );
  });
}