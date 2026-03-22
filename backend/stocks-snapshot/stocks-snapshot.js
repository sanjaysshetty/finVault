// stocks-snapshot.js
// Scheduled daily at 5 AM Central (weekdays only).
// Reads STOCK_TX items from DynamoDB, fetches Finnhub quotes,
// computes holdings metrics (mirrors Stocks.jsx logic exactly),
// and writes stocks-snapshot.json to S3 — always overwriting the same key.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.FIN_ASSETS_TABLE;
const BUCKET = process.env.STOCKS_SNAPSHOT_BUCKET;
const SNAPSHOT_KEY = "stocks-snapshot.json";
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const USER_ID = process.env.SNAPSHOT_USER_ID; // Cognito sub of the account to snapshot
const FINNHUB_BASE = "https://finnhub.io/api/v1";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });

/* ── Timezone helpers ─────────────────────────────────────────────── */

function isoDateCentral(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${day}`;
}

function weekdayCentral(d = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "long",
  }).format(d);
}

/* ── Math helpers ─────────────────────────────────────────────────── */

function safeNum(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function round2(n) {
  return Number(safeNum(n, 0).toFixed(2));
}

/* ── DynamoDB ─────────────────────────────────────────────────────── */

async function fetchStockTransactions(userId) {
  const items = [];
  let lastKey;
  do {
    const out = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: "GSI1",
      KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :sk)",
      ExpressionAttributeValues: { ":pk": userId, ":sk": "STOCK_TX#" },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    items.push(...(out.Items || []));
    lastKey = out.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

/* ── Finnhub quotes ───────────────────────────────────────────────── */

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchFinnhubQuote(symbol) {
  const url = `${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(FINNHUB_API_KEY)}`;
  const resp = await fetchWithTimeout(url, {}, 4000);
  if (!resp.ok) throw new Error(`Finnhub ${symbol} HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data || typeof data.c !== "number") throw new Error(`Finnhub ${symbol}: unexpected response`);
  return { symbol, price: data.c, prevClose: data.pc, change: data.c - data.pc };
}

async function fetchAllQuotes(symbols) {
  const results = {};
  const errors = {};
  await Promise.allSettled(
    symbols.map(async (sym) => {
      try {
        results[sym] = await fetchFinnhubQuote(sym);
      } catch (e) {
        errors[sym] = e?.message || String(e);
      }
    })
  );
  return { results, errors: Object.keys(errors).length ? errors : undefined };
}

/* ── Portfolio computation — mirrors Stocks.jsx exactly ──────────── */

function computeStockMetrics(transactions, quoteMap) {
  const bySymbol = {};
  const txs = [...transactions].sort((a, b) =>
    String(a.date || "").localeCompare(String(b.date || ""))
  );

  for (const t of txs) {
    const symbol = String(t.symbol || "").toUpperCase();
    if (!symbol) continue;
    const type = String(t.type || "BUY").toUpperCase();
    const shares = safeNum(t.shares, 0);
    const price = safeNum(t.price, 0);
    const fees = safeNum(t.fees, 0);

    if (!bySymbol[symbol]) bySymbol[symbol] = { shares: 0, cost: 0, avg: 0, realized: 0, buys: 0, sells: 0 };
    const s = bySymbol[symbol];

    if (type === "BUY") {
      s.shares += shares;
      s.cost += shares * price + fees;
      s.buys++;
      s.avg = s.shares > 0 ? s.cost / s.shares : 0;
    } else if (type === "SELL") {
      const ss = Math.min(shares, s.shares);
      s.realized += ss * price - fees - ss * (s.avg || 0);
      s.shares -= ss;
      s.cost -= ss * (s.avg || 0);
      s.sells++;
      s.avg = s.shares > 0 ? s.cost / s.shares : 0;
    }
  }

  const holdings = Object.entries(bySymbol)
    .map(([symbol, s]) => {
      const q = quoteMap[symbol];
      const spot = safeNum(q?.price, 0);
      const prevClose = safeNum(q?.prevClose, 0);
      const mv = s.shares * spot;
      const hasPrev = prevClose > 0;
      const change = hasPrev ? spot - prevClose : null;
      return {
        symbol,
        shares: round2(s.shares),
        avgCost: round2(s.avg),
        spot: round2(spot),
        prevClose: round2(prevClose),
        marketValue: round2(mv),
        unrealized: round2((spot - (s.avg || 0)) * s.shares),
        realized: round2(s.realized),
        buys: s.buys,
        sells: s.sells,
        dayGL: hasPrev ? round2(s.shares * change) : null,
        dayGLPct: hasPrev ? round2((change / prevClose) * 100) : null,
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue);

  const totals = holdings.reduce(
    (acc, h) => {
      acc.holdingValue += h.marketValue;
      acc.unrealized += h.unrealized;
      acc.realized += h.realized;
      acc.totalCost += h.shares * (h.avgCost || 0);
      if (h.dayGL != null) {
        acc.dayGL += h.dayGL;
        acc.hasDayGL = true;
        acc.prevDayValue += h.shares * h.prevClose;
      }
      return acc;
    },
    { holdingValue: 0, unrealized: 0, realized: 0, dayGL: 0, hasDayGL: false, totalCost: 0, prevDayValue: 0 }
  );

  return {
    holdings,
    totals: {
      holdingValue: round2(totals.holdingValue),
      unrealized: round2(totals.unrealized),
      realized: round2(totals.realized),
      dayGL: totals.hasDayGL ? round2(totals.dayGL) : null,
      totalCost: round2(totals.totalCost),
      prevDayValue: round2(totals.prevDayValue),
    },
  };
}

// FIFO lot tracker — mirrors computeStockYTDRealized from Stocks.jsx
function computeYTDRealized(transactions) {
  const year = new Date().getFullYear();
  const yearStart = `${year}-01-01`;
  const txs = [...transactions].sort((a, b) =>
    String(a.date || "").localeCompare(String(b.date || ""))
  );
  const lots = {}; // symbol -> [{ date, qty, costPerUnit }]
  let shortTerm = 0;
  let longTerm = 0;

  for (const t of txs) {
    const sym = String(t.symbol || "").toUpperCase().trim();
    if (!sym) continue;
    const type = String(t.type || "BUY").toUpperCase();
    const qty = safeNum(t.shares, 0);
    const price = safeNum(t.price, 0);
    const fees = safeNum(t.fees, 0);
    if (qty <= 0) continue;
    if (!lots[sym]) lots[sym] = [];

    if (type === "BUY") {
      lots[sym].push({ date: t.date || "", qty, costPerUnit: (qty * price + fees) / qty });
    } else if (type === "SELL") {
      const netPerUnit = (qty * price - fees) / qty;
      let rem = qty;
      const isCY = t.date && t.date >= yearStart;
      while (rem > 0 && lots[sym].length > 0) {
        const lot = lots[sym][0];
        const used = Math.min(rem, lot.qty);
        if (isCY) {
          const gain = used * (netPerUnit - lot.costPerUnit);
          const days = lot.date ? (new Date(t.date) - new Date(lot.date)) / 86400000 : 0;
          if (days > 365) longTerm += gain;
          else shortTerm += gain;
        }
        lot.qty -= used;
        rem -= used;
        if (lot.qty <= 0) lots[sym].shift();
      }
    }
  }

  return {
    year,
    shortTerm: round2(shortTerm),
    longTerm: round2(longTerm),
    total: round2(shortTerm + longTerm),
  };
}

/* ── Handler ──────────────────────────────────────────────────────── */

export const handler = async (event = {}) => {
  const now = new Date();
  const snapshotDate = isoDateCentral(now);
  const weekday = weekdayCentral(now);

  if (!TABLE || !BUCKET || !FINNHUB_API_KEY || !USER_ID) {
    throw new Error(
      `Missing required env vars. TABLE=${TABLE} BUCKET=${BUCKET} USER_ID=${USER_ID} FINNHUB_KEY=${!!FINNHUB_API_KEY}`
    );
  }

  // Skip weekends — markets closed, Finnhub prices are stale from Friday.
  // Pass { "force": true } in the event payload to bypass (e.g. manual test runs).
  if (!event.force && (weekday === "Saturday" || weekday === "Sunday")) {
    const result = { snapshotDate, skipped: true, reason: `${weekday} in America/Chicago — markets closed` };
    console.log("Skipped:", JSON.stringify(result));
    return result;
  }

  // 1. Load all stock transactions from DynamoDB
  const transactions = await fetchStockTransactions(USER_ID);
  console.log(`Loaded ${transactions.length} STOCK_TX items for userId=${USER_ID}`);

  // 2. Derive unique symbols from open positions
  const symbols = [...new Set(
    transactions.map((t) => String(t.symbol || "").toUpperCase()).filter(Boolean)
  )].sort();

  // 3. Fetch live quotes from Finnhub
  let quoteMap = {};
  let quoteErrors;
  if (symbols.length) {
    const { results, errors } = await fetchAllQuotes(symbols);
    quoteMap = results;
    quoteErrors = errors;
  }

  // 4. Compute holdings and YTD realized P/L
  const { holdings, totals } = computeStockMetrics(transactions, quoteMap);
  const ytdRealized = computeYTDRealized(transactions);

  // 5. Build snapshot payload
  const snapshot = {
    snapshotDate,
    snapshotTimestamp: now.toISOString(),
    userId: USER_ID,
    transactionCount: transactions.length,
    symbolCount: symbols.length,
    totals,
    ytdRealized,
    holdings,
    ...(quoteErrors ? { quoteErrors } : {}),
  };

  // 6. Write to S3, always overwriting the same key
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: SNAPSHOT_KEY,
    Body: JSON.stringify(snapshot, null, 2),
    ContentType: "application/json",
    CacheControl: "no-store",
  }));

  const summary = {
    snapshotDate,
    bucket: BUCKET,
    key: SNAPSHOT_KEY,
    holdingValue: totals.holdingValue,
    unrealized: totals.unrealized,
    dayGL: totals.dayGL,
    holdingCount: holdings.length,
  };
  console.log("Snapshot written:", JSON.stringify(summary));
  return summary;
};
