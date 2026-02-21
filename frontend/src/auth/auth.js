// src/auth/auth.js
const COGNITO_DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN;
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID;
const REDIRECT_URI = import.meta.env.VITE_COGNITO_REDIRECT_URI;
const LOGOUT_URI = import.meta.env.VITE_COGNITO_LOGOUT_URI;

const TOKEN_KEY = "finvault.accessToken";
const ID_TOKEN_KEY = "finvault.idToken";
const REFRESH_KEY = "finvault.refreshToken";
const PKCE_VERIFIER_KEY = "finvault.pkce.verifier";

/** PKCE storage helpers: session for normal flow + local fallback for mobile */
function pkceSet(verifier) {
  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  localStorage.setItem(PKCE_VERIFIER_KEY, verifier);
}

function pkceGet() {
  return (
    sessionStorage.getItem(PKCE_VERIFIER_KEY) ||
    localStorage.getItem(PKCE_VERIFIER_KEY)
  );
}

function pkceClear() {
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  localStorage.removeItem(PKCE_VERIFIER_KEY);
}

function b64UrlEncode(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash);
}

function randomString(len = 64) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return b64UrlEncode(buf);
}

export function getAccessToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function isLoggedIn() {
  return !!getAccessToken();
}

export function logout() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(ID_TOKEN_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
  pkceClear();

  const url =
    `${COGNITO_DOMAIN}/logout?` +
    new URLSearchParams({
      client_id: CLIENT_ID,
      logout_uri: LOGOUT_URI,
    }).toString();

  window.location.assign(url);
}

export async function login() {
  const verifier = randomString(64);
  pkceSet(verifier);

  const challenge = b64UrlEncode(await sha256(verifier));

  const url =
    `${COGNITO_DOMAIN}/oauth2/authorize?` +
    new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "openid email profile",
      code_challenge_method: "S256",
      code_challenge: challenge,
    }).toString();

  window.location.assign(url);
}

export async function handleAuthCallback() {
  const params = new URLSearchParams(window.location.search);

  // ✅ If Cognito redirected with an error, show it
  const err = params.get("error");
  const errDesc = params.get("error_description");
  if (err) {
    throw new Error(decodeURIComponent(errDesc || err));
  }

  // ✅ Support rare cases where code ends up in hash (defensive)
  let code = params.get("code");
  if (!code && window.location.hash) {
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    code = hashParams.get("code");
  }

  if (!code) throw new Error("Missing authorization code");

  const verifier = pkceGet();
  if (!verifier) {
    pkceClear();
    throw new Error(
      "Missing PKCE verifier (session lost). Please tap Login again."
    );
  }

  const tokenUrl = `${COGNITO_DOMAIN}/oauth2/token`;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || "Token exchange failed");

  sessionStorage.setItem(TOKEN_KEY, json.access_token);
  if (json.id_token) sessionStorage.setItem(ID_TOKEN_KEY, json.id_token);
  if (json.refresh_token) sessionStorage.setItem(REFRESH_KEY, json.refresh_token);

  pkceClear();

  const base = window.location.pathname.startsWith("/app") ? "/app" : "";
  window.history.replaceState({}, document.title, `${base}/`);
}