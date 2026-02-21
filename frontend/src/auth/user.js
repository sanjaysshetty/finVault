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

  const firstName = claims.given_name || "";
  const lastName = claims.family_name || "";

  // Cognito sometimes provides `name`, but given/family are more reliable if enabled
  const fullName =
    claims.name || [firstName, lastName].filter(Boolean).join(" ");

  return {
    email: claims.email,
    username:
      claims.preferred_username ||
      claims["cognito:username"] ||
      claims.email,

    firstName,
    lastName,
    name: fullName,

    // handy stable ID for future permissions work
    userId: claims.sub,
  };
}