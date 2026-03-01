const { S3Client, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const FINNHUB_BASE = "https://finnhub.io/api/v1";
const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

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
    .slice(0, 25);
}

/* -------------------- S3 + DynamoDB clients -------------------- */
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const METALS_BUCKET = process.env.METALS_BUCKET || "finvault-metal-prices-sandbox-1152";
const PRICE_CACHE_TABLE = process.env.PRICE_CACHE_TABLE;
const PRICE_CACHE_TTL_MS = 60_000; // 60 seconds application-level TTL

const s3 = new S3Client({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

/* -------------------- Price cache (DynamoDB) -------------------- */
async function getCachedPrices(cacheKey) {
  if (!PRICE_CACHE_TABLE) return null;
  try {
    const resp = await ddb.send(new GetCommand({
      TableName: PRICE_CACHE_TABLE,
      Key: { cacheKey },
    }));
    const item = resp.Item;
    if (!item?.cachedAt) return null;
    const age = Date.now() - new Date(item.cachedAt).getTime();
    return age < PRICE_CACHE_TTL_MS ? item.data : null;
  } catch {
    return null;
  }
}

async function setCachedPrices(cacheKey, data) {
  if (!PRICE_CACHE_TABLE) return;
  try {
    const now = new Date();
    await ddb.send(new PutCommand({
      TableName: PRICE_CACHE_TABLE,
      Item: {
        cacheKey,
        data,
        cachedAt: now.toISOString(),
        ttl: Math.floor(now.getTime() / 1000) + 3600, // DynamoDB TTL: clean up after 1 hour
      },
    }));
  } catch {
    // Cache write failures are non-fatal
  }
}

function isoDateUTC(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

async function streamToString(body) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    body.on("data", (chunk) => chunks.push(chunk));
    body.on("error", reject);
    body.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

function metalPrefix(metal) {
  return `metals/${metal}/`;
}

function metalKeyForDate(metal, isoDate) {
  return `${metalPrefix(metal)}${isoDate}.json`;
}

async function getJsonFromS3(bucket, key) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await streamToString(resp.Body);
  return JSON.parse(text);
}

async function listLatestKey(bucket, prefix) {
  let token = undefined;
  let best = null;

  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: 1000,
      })
    );

    const contents = resp.Contents || [];
    for (const obj of contents) {
      if (!obj || !obj.Key || !obj.LastModified) continue;
      if (!best || obj.LastModified > best.LastModified) best = obj;
    }

    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);

  return best?.Key || null;
}

/**
 * fetchMetal
 * - returns today's JSON if present
 * - otherwise returns the latest JSON in the bucket for that metal
 */
async function fetchMetal(metal, currency, apiKey) {
  const today = isoDateUTC();
  const todayKey = metalKeyForDate(metal, today);

  try {
    const data = await getJsonFromS3(METALS_BUCKET, todayKey);
    return data;
  } catch (e) {
    const msg = String(e?.name || e?.message || e);

    const isNotFound = msg.includes("NoSuchKey") || msg.includes("NotFound") || msg.includes("404");
    if (!isNotFound) {
      throw new Error(`S3 read failed for ${todayKey}: ${String(e?.message || e)}`);
    }

    const prefix = metalPrefix(metal);
    const latestKey = await listLatestKey(METALS_BUCKET, prefix);
    if (!latestKey) {
      throw new Error(`No metal price files found in s3://${METALS_BUCKET}/${prefix}`);
    }

    const latest = await getJsonFromS3(METALS_BUCKET, latestKey);
    return { ...latest, fallbackUsed: true, fallbackKey: latestKey };
  }
}

/* -------------------- Yahoo Indices (server-side, no CORS) -------------------- */

function toNum(x) {
  const n = typeof x === "string" ? Number(x) : x;
  return Number.isFinite(n) ? n : null;
}

function lastTwoFinite(nums) {
  const arr = (nums || []).map(toNum).filter((n) => Number.isFinite(n));
  if (arr.length < 2) return { last: arr.at(-1) ?? null, prev: null };
  return { last: arr.at(-1), prev: arr.at(-2) };
}

/**
 * fetchYahooIndex
 * Returns: { symbol, price, prevClose, timestamp }
 *
 * Fix: compute prevClose from daily close series first (more reliable),
 * then fall back to meta.previousClose/chartPreviousClose.
 */
async function fetchYahooIndex(symbol) {
  // Use daily bars to make prevClose stable/predictable
  const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=5d`;

  const resp = await fetchWithTimeout(
    url,
    {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
      },
    },
    3500
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Yahoo ${symbol} ${resp.status}: ${text}`);
  }

  const json = await resp.json();
  const result = json?.chart?.result?.[0] || null;
  const meta = result?.meta || null;

  // Daily closes array (interval=1d)
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const { last: lastClose, prev: prevCloseFromSeries } = lastTwoFinite(closes);

  // Current price: prefer regularMarketPrice; fall back to last daily close
  const price =
    toNum(meta?.regularMarketPrice) ??
    toNum(meta?.regularMarketPreviousClose) ?? // sometimes appears
    toNum(lastClose) ??
    null;

  // Prev close: prefer series-derived (most stable), then meta
  const prevClose =
    toNum(prevCloseFromSeries) ??
    toNum(meta?.previousClose) ??
    toNum(meta?.chartPreviousClose) ??
    null;

  const timestamp =
    toNum(meta?.regularMarketTime) ??
    toNum(result?.timestamp?.slice(-1)?.[0]) ??
    null;

  return { symbol, price, prevClose, timestamp };
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

  const q = getQuery(event);

  const stockSymbols = parseCsvSymbols(q.stocks || q.symbols);
  const cryptoSymbols = parseCsvSymbols(q.crypto).map((s) => (s.includes("-") ? s : `${s}-USD`));

  // Cache only requests without custom stock symbols (covers PricesBar's common call path).
  // Stock quotes are per-page and change frequently; skip caching for those.
  const cacheKey = stockSymbols.length
    ? null
    : `PRICES:${[...cryptoSymbols].sort().join(",")}`;

  if (cacheKey) {
    const cached = await getCachedPrices(cacheKey);
    if (cached) {
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify({ ...cached, fromCache: true }),
      };
    }
  }

  let gold = null;
  let silver = null;
  let copper = null;

  let sp500 = null;
  let nasdaq = null;

  let crypto = null;
  let stocks = undefined;

  // Metals from S3
  try {
    gold = await fetchMetal("XAU", currency, "ignored");
  } catch (e) {
    errors.gold = String(e?.message || e);
  }

  try {
    silver = await fetchMetal("XAG", currency, "ignored");
  } catch (e) {
    errors.silver = String(e?.message || e);
  }

  try {
    copper = await fetchMetal("XCU", currency, "ignored");
  } catch (e) {
    errors.copper = String(e?.message || e);
  }

  // Indices from Yahoo (server-side)
  try {
    sp500 = await fetchYahooIndex("^GSPC");
  } catch (e) {
    errors.sp500 = String(e?.message || e);
  }

  try {
    nasdaq = await fetchYahooIndex("^IXIC");
  } catch (e) {
    errors.nasdaq = String(e?.message || e);
  }

  /* ---- Crypto (Yahoo Finance — returns { symbol, price, prevClose, timestamp }) ---- */
  try {
    const defaultCrypto = ["BTC-USD", "ETH-USD"];
    const requestedCrypto = cryptoSymbols.length ? cryptoSymbols : defaultCrypto;
    const cryptoSettled = await Promise.allSettled(requestedCrypto.map((sym) => fetchYahooIndex(sym)));
    crypto = {};
    cryptoSettled.forEach((r, i) => {
      if (r.status === "fulfilled") crypto[requestedCrypto[i]] = r.value;
      else errors[`crypto.${requestedCrypto[i]}`] = String(r.reason?.message || r.reason);
    });
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
    sp500,
    nasdaq,
    gold,
    silver,
    copper,
    crypto,
    ...(stocks ? { stocks } : {}),
    errors: Object.keys(errors).length ? errors : undefined,
    fetchedAt: new Date().toISOString(),
  };

  if (cacheKey) await setCachedPrices(cacheKey, responseBody);

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(responseBody),
  };
};
