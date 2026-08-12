import { useMsal } from "@azure/msal-react";
import { loginRequest } from "../auth/msalConfig";

// Shown to users who are not signed in. The button starts the Microsoft
// sign-in flow (redirects to Microsoft, then back to our app).

function LoginScreen() {
  const { instance } = useMsal();

  function handleLogin() {
    instance.loginRedirect(loginRequest);
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-icon">🤖</div>
        <h1>עוזר החברה</h1>
        <p>כדי להשתמש בצ'אט, התחברו עם חשבון Microsoft הארגוני שלכם.</p>
        <button className="login-button" onClick={handleLogin}>
          התחברות עם Microsoft
        </button>
      </div>
    </div>
  );
}

export default LoginScreen;