export function logout() {
  // 1️⃣ Clear local session
  sessionStorage.removeItem("finvault.accessToken");
  sessionStorage.removeItem("finvault.idToken");
  sessionStorage.removeItem("finvault.refreshToken");
  sessionStorage.removeItem("access_token");
  sessionStorage.removeItem("id_token");

  // 2️⃣ Build Cognito logout URL
  const domain = import.meta.env.VITE_COGNITO_DOMAIN;
  const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID;

  // ✅ Use explicit env logout URI (works for both local + prod)
  const logoutUri =
    import.meta.env.VITE_COGNITO_LOGOUT_URI ||
    new URL(import.meta.env.BASE_URL || "/", window.location.origin).toString();

  const url =
    `${domain}/logout` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&logout_uri=${encodeURIComponent(logoutUri)}`;

  // 3️⃣ Redirect to Cognito logout
  window.location.assign(url);
}
