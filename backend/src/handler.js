const nacl = require("tweetnacl");

const GOLDAPI_BASE = "https://www.goldapi.io/api";
const RH_BASE = "https://trading.robinhood.com";
const FINNHUB_BASE = "https://finnhub.io/api/v1";

/* -------------------- CORS -------------------- */
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
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

/* -------------------- Query helpers -------------------- */
function getQuery(event) {
  return event?.queryStringParameters || {};
}

function parseCsvSymbols(s) {
  if (!s) return [];
  return String(s)
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 25); // safety cap
}

/* -------------------- GoldAPI -------------------- */
async function fetchMetal(metal, currency, apiKey) {
  if (process.env.USE_METAL_PRICE_STUB === "true") {
    return {
      timestamp: 1769454792,
      metal,
      currency,
      exchange: "FOREXCOM",
      symbol: `FOREXCOM:${metal}${currency}`,
      prev_close_price: 4986.45,
      open_price: 4986.45,
      low_price: 4986.45,
      high_price: 5111.01,
      open_time: 1769385600,
      price: metal === "XAU" ? 5058.84 : 24.5,
      ch: 72.39,
      chp: 1.45,
      ask: 5061.22,
      bid: 5060.31,
      price_gram_24k: 162.6455,
      price_gram_22k: 149.0917,
      price_gram_21k: 142.3148,
      price_gram_20k: 135.5379,
      price_gram_18k: 121.9841,
      price_gram_16k: 108.4303,
      price_gram_14k: 94.8765,
      price_gram_10k: 67.769,
      _stub: true,
    };
  }

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

  const qs = symbols.map((s) => `symbol=${encodeURIComponent(s)}`).join("&");
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

/* -------------------- Finnhub stock quotes -------------------- */
async function fetchFinnhubQuote(symbol, apiKey) {
  const url = `${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`;
  const resp = await fetchWithTimeout(url, {}, 3500);

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Finnhub ${symbol} ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  if (!data || typeof data.c !== "number") {
    throw new Error(`Finnhub ${symbol}: invalid response`);
  }
  return data;
}

async function fetchFinnhubQuotes(symbols, apiKey) {
  const results = {};
  const errors = {};

  const settled = await Promise.allSettled(
    symbols.map(async (sym) => {
      const q = await fetchFinnhubQuote(sym, apiKey);
      results[sym] = {
        symbol: sym,
        price: q.c,
        prevClose: q.pc,
        open: q.o,
        high: q.h,
        low: q.l,
        change: q.d,
        changePct: q.dp,
        timestamp: q.t,
      };
    })
  );

  settled.forEach((r, idx) => {
    if (r.status === "rejected") {
      errors[symbols[idx]] = String(r.reason?.message || r.reason || "Finnhub error");
    }
  });

  return { results, errors: Object.keys(errors).length ? errors : undefined };
}

/* -------------------- Lambda handler -------------------- */
exports.handler = async (event) => {
  if (event?.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(), body: "" };
  }

  const currency = "USD";
  const errors = {};

  // ✅ Parse query FIRST (fixes your "q used before init" issue)
  const q = getQuery(event);

  // Optional request: /prices?stocks=AAPL,MSFT
  const stockSymbols = parseCsvSymbols(q.stocks || q.symbols);

  // Optional request: /prices?crypto=BTC-USD,ETH-USD,DOGE-USD
  const cryptoSymbols = parseCsvSymbols(q.crypto).map((s) =>
    s.includes("-") ? s : `${s}-USD`
  );

  let gold = null;
  let silver = null;
  let crypto = null;
  let stocks = undefined;

  // ✅ Do NOT hard-fail if GOLDAPI key is missing (keep crypto/stocks working)
  const goldKey = process.env.GOLDAPI_KEY;
  if (!goldKey) {
    errors.gold = "Missing GOLDAPI_KEY env var";
    errors.silver = "Missing GOLDAPI_KEY env var";
  } else {
    try {
      gold = await fetchMetal("XAU", currency, goldKey);
    } catch (e) {
      errors.gold = String(e?.message || e);
    }

    try {
      silver = await fetchMetal("XAG", currency, goldKey);
    } catch (e) {
      errors.silver = String(e?.message || e);
    }
  }

  /* ---- Crypto ---- */
  try {
    const defaultCrypto = ["BTC-USD", "ETH-USD"];
    const requestedCrypto = cryptoSymbols.length ? cryptoSymbols : defaultCrypto;
    crypto = await fetchRhBestBidAsk(requestedCrypto);
  } catch (e) {
    errors.crypto = String(e?.message || e);
  }

  /* ---- Stocks (optional) ---- */
  if (stockSymbols.length) {
    const finnhubKey = process.env.FINNHUB_API_KEY;
    if (!finnhubKey) {
      errors.stocks = "Missing FINNHUB_API_KEY env var";
    } else {
      try {
        const { results, errors: stockErrors } = await fetchFinnhubQuotes(stockSymbols, finnhubKey);
        stocks = results;
        if (stockErrors) errors.stocks = stockErrors;
      } catch (e) {
        errors.stocks = String(e?.message || e);
      }
    }
  }

  const responseBody = {
    currency,
    gold,
    silver,
    crypto,
    ...(stocks ? { stocks } : {}),
    errors: Object.keys(errors).length ? errors : undefined,
    fetchedAt: new Date().toISOString(),
  };

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(responseBody),
  };
};
