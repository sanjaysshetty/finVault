function decodeJwt(token) {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

export function getLoggedInUser() {
  const idToken =
    sessionStorage.getItem("finvault.idToken") ||
    sessionStorage.getItem("id_token");

  if (!idToken) return null;

  const claims = decodeJwt(idToken);
  if (!claims) return null;

  return {
    email: claims.email,
    username:
      claims.preferred_username ||
      claims["cognito:username"] ||
      claims.email,
    name: claims.name,
  };
}
