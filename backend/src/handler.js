const nacl = require("tweetnacl");

const GOLDAPI_BASE = "https://www.goldapi.io/api";
const RH_BASE = "https://trading.robinhood.com";

/* -------------------- CORS -------------------- */
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    // ✅ add Authorization
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
}


/* -------------------- Fetch with timeout -------------------- */
async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}


/* -------------------- GoldAPI -------------------- */
async function fetchMetal(metal, currency, apiKey) {
  const url = `${GOLDAPI_BASE}/${metal}/${currency}`;

  const resp = await fetchWithTimeout(
    url,
    {
      headers: {
        "x-access-token": apiKey,
        "Content-Type": "application/json",
      },
    },
    3500
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GoldAPI ${metal} ${resp.status}: ${text}`);
  }

  return resp.json();
}
/* -------------------- Robinhood signing -------------------- */
function b64ToUint8(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function makeRhSignature({ apiKey, privateKeyB64, timestamp, path, method, bodyStr }) {
  const message = `${apiKey}${timestamp}${path}${method}${bodyStr || ""}`;
  const msgBytes = new TextEncoder().encode(message);

  const rawKey = b64ToUint8(privateKeyB64);
  const seed = rawKey.length === 64 ? rawKey.slice(0, 32) : rawKey;

  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  const sig = nacl.sign.detached(msgBytes, keyPair.secretKey);

  return Buffer.from(sig).toString("base64");
}

/* -------------------- Robinhood Best Bid / Ask -------------------- */
async function fetchRhBestBidAsk(symbols) {
  const apiKey = process.env.RH_API_KEY;
  const privateKeyB64 = process.env.RH_PRIVATE_KEY_B64;

  if (!apiKey || !privateKeyB64) {
    throw new Error("Missing RH_API_KEY or RH_PRIVATE_KEY_B64");
  }

  const qs = symbols.map(s => `symbol=${encodeURIComponent(s)}`).join("&");
  const path = `/api/v2/crypto/marketdata/best_bid_ask/?${qs}`;
  const url = `${RH_BASE}${path}`;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const method = "GET";
  const bodyStr = "";

  const signature = makeRhSignature({
    apiKey,
    privateKeyB64,
    timestamp,
    path,
    method,
    bodyStr,
  });

  const resp = await fetchWithTimeout(
    url,
    {
      method,
      headers: {
        "x-api-key": apiKey,
        "x-timestamp": timestamp,
        "x-signature": signature,
        "Content-Type": "application/json; charset=utf-8",
      },
    },
    3500
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Robinhood ${resp.status}: ${text}`);
  }

  return resp.json();
}

/* -------------------- Lambda handler -------------------- */
exports.handler = async (event) => {
  if (event?.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(), body: "" };
  }

  const goldKey = process.env.GOLDAPI_KEY;
  if (!goldKey) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Missing GOLDAPI_KEY env var" }),
    };
  }

  const currency = "USD";
  const errors = {};

  let gold = null;
  let silver = null;
  let crypto = null;

  /* ---- Gold ---- */
  try {
    gold = await fetchMetal("XAU", currency, goldKey);
  } catch (e) {
    errors.gold = String(e);
  }

  /* ---- Silver ---- */
  try {
    silver = await fetchMetal("XAG", currency, goldKey);
  } catch (e) {
    errors.silver = String(e);
  }

  /* ---- Crypto ---- */
  try {
    crypto = await fetchRhBestBidAsk(["BTC-USD", "ETH-USD"]);
  } catch (e) {
    errors.crypto = String(e);
  }

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({
      currency,
      gold,
      silver,
      crypto,
      errors: Object.keys(errors).length ? errors : undefined,
      fetchedAt: new Date().toISOString(),
    }),
  };
};
