// backend/options-agg/sync/app.js
// Node.js 18+ (fetch is available)

// Helper: YYYY-MM-DD in UTC (today)
function todayUtcIsoDate() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Build OCC-style option ticker used by Polygon/Massive:
 * O:{UNDERLYING}{YYMMDD}{C|P}{STRIKE*1000 padded to 8 digits}
 *
 * Example:
 * underlying=SPY, exp=2025-12-19, type=C, strike=650.00
 * => O:SPY251219C00650000
 */
function toOCCOptionTicker({ underlying, expiration, contractType, strike }) {
  if (!underlying || !expiration || !contractType || strike === undefined || strike === null) {
    throw new Error("Missing required fields: underlying, expiration, contractType, strike");
  }

  const root = String(underlying).toUpperCase().trim();
  const cp = String(contractType).toUpperCase().trim();
  if (cp !== "C" && cp !== "P") throw new Error("contractType must be 'C' or 'P'");

  // expiration can be "YYYY-MM-DD" or "YYYYMMDD"
  let y, m, d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(expiration)) {
    [y, m, d] = expiration.split("-").map((x) => parseInt(x, 10));
  } else if (/^\d{8}$/.test(expiration)) {
    y = parseInt(expiration.slice(0, 4), 10);
    m = parseInt(expiration.slice(4, 6), 10);
    d = parseInt(expiration.slice(6, 8), 10);
  } else {
    throw new Error("expiration must be YYYY-MM-DD or YYYYMMDD");
  }

  const yy = String(y % 100).padStart(2, "0");
  const mm = pad2(m);
  const dd = pad2(d);

  // strike: allow number or string (e.g., "650", "650.00")
  const strikeNum = Number(strike);
  if (!Number.isFinite(strikeNum) || strikeNum <= 0) throw new Error("strike must be a positive number");

  // OCC encoding: strike * 1000, 8 digits zero-padded
  const strikeInt = Math.round(strikeNum * 1000); // 650.00 -> 650000
  const strikePart = String(strikeInt).padStart(8, "0");

  return `O:${root}${yy}${mm}${dd}${cp}${strikePart}`;
}

function buildHeaders() {
  const apiKey = process.env.MASSIVE_API_KEY;
  if (!apiKey) throw new Error("Missing env MASSIVE_API_KEY");

  // Massive accounts can differ on header expectations.
  // We support both common patterns via env var.
  const authMode = (process.env.MASSIVE_AUTH_MODE || "bearer").toLowerCase();
  if (authMode === "x-api-key") {
    return { "X-API-KEY": apiKey };
  }
  // default bearer
  return { Authorization: `Bearer ${apiKey}` };
}

function getApiBase() {
  const base = process.env.MASSIVE_API_BASE;
  if (!base) {
    throw new Error("Missing env MASSIVE_API_BASE (e.g., https://api.massive.com)");
  }
  return base.replace(/\/+$/, "");
}

async function httpGetJson(url, headers) {
  const resp = await fetch(url, { method: "GET", headers });
  const text = await resp.text().catch(() => "");

  if (!resp.ok) {
    throw new Error(`Massive API ${resp.status} ${resp.statusText}: ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Calls open-close API for "today" (UTC date) unless overridden via event.priceDate.
 * Endpoint:
 *   /v1/open-close/{optionsTicker}/{date}
 */
async function fetchOpenCloseToday({ optionsTicker, priceDate }) {
  const base = getApiBase();
  const headers = buildHeaders();

  const date = priceDate || todayUtcIsoDate(); // build PRICE_DATE dynamically
  const url = `${base}/v1/open-close/${encodeURIComponent(optionsTicker)}/${date}`;

  const data = await httpGetJson(url, headers);

  // open-close response typically includes open/close; we normalize "latestPrice" to close
  const latestPrice = data && typeof data === "object" ? (data.close ?? null) : null;

  return { mode: "openclose", date, url, latestPrice, raw: data };
}

/**
 * Handler:
 * - Accepts inputs either via event JSON or environment variables.
 *
 * Event example:
 * {
 *   "underlying":"SPY",
 *   "expiration":"2025-12-19",
 *   "type":"C",
 *   "strike":650,
 *   "priceDate":"2026-02-03"   // optional override
 * }
 */
exports.handler = async (event = {}) => {
  const qs = event.queryStringParameters || {};

  const underlying =
    qs.underlying || event.underlying || process.env.UNDERLYING || "SPY";

  const expiration =
    qs.expiration || event.expiration || process.env.EXPIRATION || "2025-12-19";

  // accept both "contractType" and "type"
  const contractType =
    qs.contractType ||
    qs.type ||
    event.contractType ||
    event.type ||
    process.env.CONTRACT_TYPE ||
    "C";

  const strikeRaw =
    qs.strike ?? event.strike ?? process.env.STRIKE ?? 650;

  const strike = typeof strikeRaw === "string" ? Number(strikeRaw) : strikeRaw;

  const optionsTicker = toOCCOptionTicker({
    underlying,
    expiration,
    contractType,
    strike,
  });

  const priceDate = qs.priceDate || event.priceDate || null;

  console.log("Options ticker:", optionsTicker);

  const price = await fetchOpenCloseToday({ optionsTicker, priceDate });

  return {
    ok: true,
    input: { underlying, expiration, contractType, strike },
    optionsTicker,
    priceMode: price.mode,
    priceDate: price.date,
    requestUrl: price.url,
    latestPrice: price.latestPrice,
    raw: price.raw,
  };
};

