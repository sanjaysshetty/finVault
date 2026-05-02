"use strict";

const https = require("https");
const crypto = require("crypto");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const { json, badRequest } = require("finvault-shared/http");
const { queryByGSI1 } = require("finvault-shared/ddb");
const { resolveContext, assertRead } = require("finvault-shared/resolveContext");

const ANTHROPIC_API_KEY       = process.env.ANTHROPIC_API_KEY       || "";
const ANALYTICS_BUCKET        = process.env.ANALYTICS_BUCKET        || "";
const ADVISOR_CACHE_TABLE     = process.env.ADVISOR_CACHE_TABLE     || "";
const ADVISOR_WORKER_FUNCTION = process.env.ADVISOR_WORKER_FUNCTION || "";
const MODEL = "claude-sonnet-4-6";
const FRAMEWORK_S3_KEY = "config/trade_framework.md";

/* ── AWS clients ─────────────────────────────────────────────── */
const s3     = new S3Client({});
const ddb    = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

/* ── In-memory framework cache (5-minute TTL) ───────────────── */
let frameworkCache = { text: null, loadedAt: 0 };
const FRAMEWORK_TTL_MS = 5 * 60 * 1000;

async function getFramework() {
  if (frameworkCache.text && Date.now() - frameworkCache.loadedAt < FRAMEWORK_TTL_MS) {
    return frameworkCache.text;
  }
  if (!ANALYTICS_BUCKET) {
    const err = new Error("ANALYTICS_BUCKET env var not configured");
    err.stage = "framework_load";
    throw err;
  }
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: ANALYTICS_BUCKET, Key: FRAMEWORK_S3_KEY }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf-8");
    frameworkCache = { text, loadedAt: Date.now() };
    return text;
  } catch (e) {
    const err = new Error(`Failed to load trade framework from S3: ${e.message}`);
    err.stage = "framework_load";
    throw err;
  }
}

/* ── Resolve context ─────────────────────────────────────────── */
async function resolveCtxCached(event) {
  if (!event._ctx) event._ctx = await resolveContext(event);
  return event._ctx;
}

/* ── Fetch all portfolio asset types ─────────────────────────── */
async function fetchPortfolio(userId) {
  try {
    const [
      stocks, options, crypto, bullion,
      futures, fixedIncome, otherAssets,
      insurance, nav,
    ] = await Promise.all([
      queryByGSI1(userId, "STOCK_TX#").catch(() => []),
      queryByGSI1(userId, "OPTIONS_TX#").catch(() => []),
      queryByGSI1(userId, "CRYPTO_TX#").catch(() => []),
      queryByGSI1(userId, "BULLION_TX#").catch(() => []),
      queryByGSI1(userId, "FUTURES_TX#").catch(() => []),
      queryByGSI1(userId, "FIXED_INCOME#").catch(() => []),
      queryByGSI1(userId, "OTHERASSET#").catch(() => []),
      queryByGSI1(userId, "INSURANCE#").catch(() => []),
      queryByGSI1(userId, "NAV_LIABILITIES#").catch(() => []),
    ]);
    return { stocks, options, crypto, bullion, futures, fixedIncome, otherAssets, insurance, nav };
  } catch (e) {
    const err = new Error(`Portfolio fetch failed: ${e.message}`);
    err.stage = "portfolio_build";
    throw err;
  }
}

/* ── Build a concise portfolio summary ───────────────────────── */
function buildPortfolioSummary(portfolio) {
  const lines = [];

  const stockMap = {};
  for (const tx of portfolio.stocks) {
    const sym = tx.symbol || tx.ticker || "?";
    if (!stockMap[sym]) stockMap[sym] = { shares: 0, cost: 0, country: tx.country || "USA" };
    const s = stockMap[sym];
    const shares = Number(tx.shares || 0);
    const price  = Number(tx.price  || 0);
    if (String(tx.type || "").toUpperCase() === "BUY") { s.shares += shares; s.cost += shares * price; }
    else { s.shares -= shares; s.cost -= shares * price; }
  }
  const stockLines = Object.entries(stockMap).filter(([, v]) => v.shares > 0.001).map(([sym, v]) => {
    const avg = v.shares > 0 ? (v.cost / v.shares).toFixed(2) : "0";
    return `  ${sym}: ${v.shares.toFixed(2)} shares @ avg $${avg} (${v.country})`;
  });
  if (stockLines.length) { lines.push("STOCKS:"); lines.push(...stockLines); }

  const openOptions = portfolio.options.filter(tx => {
    const leg = String(tx.leg || "").toUpperCase();
    if (["CLOSE", "ROLL_CLOSE"].includes(leg)) return false;
    if (tx.closePrice !== "" && tx.closePrice !== null && tx.closePrice !== undefined) return false;
    if (tx.closeDate && String(tx.closeDate).trim() !== "") return false;
    return true;
  });
  if (openOptions.length) {
    lines.push("\nOPEN OPTIONS POSITIONS (open only):");
    for (const o of openOptions)
      lines.push(`  ${o.ticker} ${(o.event || "").toUpperCase()} ${o.strikes} exp ${o.expiry} | ${o.type} ${o.qty} contracts @ $${o.fill}`);
  }

  const cryptoMap = {};
  for (const tx of portfolio.crypto) {
    const sym = tx.symbol || tx.ticker || "?";
    if (!cryptoMap[sym]) cryptoMap[sym] = { qty: 0, cost: 0 };
    const c = cryptoMap[sym];
    const qty   = Number(tx.qty   || tx.shares || 0);
    const price = Number(tx.price || tx.fill   || 0);
    if (String(tx.type || "").toUpperCase() === "BUY") { c.qty += qty; c.cost += qty * price; }
    else { c.qty -= qty; c.cost -= qty * price; }
  }
  const cryptoLines = Object.entries(cryptoMap).filter(([, v]) => v.qty > 0.00001).map(([sym, v]) => {
    const avg = v.qty > 0 ? (v.cost / v.qty).toFixed(2) : "0";
    return `  ${sym}: ${v.qty.toFixed(6)} @ avg $${avg}`;
  });
  if (cryptoLines.length) { lines.push("\nCRYPTO:"); lines.push(...cryptoLines); }

  const bullionMap = {};
  for (const tx of portfolio.bullion) {
    const metal = (tx.metal || tx.type || "?").toUpperCase();
    if (!bullionMap[metal]) bullionMap[metal] = { qty: 0 };
    bullionMap[metal].qty += Number(tx.qty || tx.weight || tx.grams || 0);
  }
  const bullionLines = Object.entries(bullionMap).filter(([, v]) => v.qty > 0).map(([m, v]) => `  ${m}: ${v.qty} units`);
  if (bullionLines.length) { lines.push("\nBULLION:"); lines.push(...bullionLines); }

  if (portfolio.fixedIncome.length) {
    lines.push("\nFIXED INCOME:");
    for (const fi of portfolio.fixedIncome)
      lines.push(`  ${fi.name || fi.ticker || "Bond"}: $${fi.principal || fi.face || fi.amount || "?"} @ ${fi.rate || fi.coupon || "?"}% | Maturity: ${fi.maturity || fi.expiry || "?"}`);
  }
  if (portfolio.otherAssets.length) {
    lines.push("\nOTHER ASSETS:");
    for (const a of portfolio.otherAssets)
      lines.push(`  ${a.name || a.ticker || "Asset"}: $${a.value || a.currentValue || "?"}`);
  }
  if (portfolio.nav.length) {
    const liabilities = portfolio.nav.filter(n => n.assetType === "NAV_LIABILITIES");
    if (liabilities.length) {
      lines.push("\nLIABILITIES:");
      for (const l of liabilities)
        lines.push(`  ${l.name || l.description || "Liability"}: $${l.balance || l.amount || "?"}`);
    }
  }
  return lines.length ? lines.join("\n") : "No portfolio data available.";
}

/* ── Build margin context string (optional) ──────────────────── */
function buildMarginContext(marginData) {
  if (!marginData) return null;
  const { totalMargin, marginUsed, freeCash, todayPnl, weekPnl } = marginData;
  const parts = [];
  if (totalMargin != null) parts.push(`Total margin: $${totalMargin}`);
  if (marginUsed  != null) parts.push(`Margin used: $${marginUsed}`);
  if (freeCash    != null) parts.push(`Free cash: $${freeCash}`);
  if (todayPnl    != null) parts.push(`Today's realized P&L: $${todayPnl}`);
  if (weekPnl     != null) parts.push(`This week's realized P&L: $${weekPnl}`);
  return parts.length ? parts.join(" | ") : null;
}

/* ── Build request cache key ─────────────────────────────────── */
function buildCacheKey(accountId, message, history, images) {
  const payload = JSON.stringify({
    accountId,
    message: String(message).trim(),
    historyLen: (history || []).length,
    imageFingerprint: (images || []).map(img => `${img.media_type}:${(img.data || "").length}`),
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/* ── DDB cache read ──────────────────────────────────────────── */
async function readCache(cacheKey) {
  if (!ADVISOR_CACHE_TABLE) return null;
  try {
    const res = await ddb.send(new GetCommand({ TableName: ADVISOR_CACHE_TABLE, Key: { cacheKey } }));
    return res.Item || null;
  } catch { return null; }
}

/* ── DDB cache write — stores reply or error ─────────────────── */
async function writeCache(cacheKey, data) {
  if (!ADVISOR_CACHE_TABLE) return;
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 60; // 30 min TTL
  try {
    await ddb.send(new PutCommand({
      TableName: ADVISOR_CACHE_TABLE,
      Item: { cacheKey, ...data, expiresAt, updatedAt: new Date().toISOString() },
    }));
  } catch (e) {
    console.error(JSON.stringify({ level: "WARN", event: "cache_write_failed", error: e.message }));
  }
}

/* ── Build system prompt parts ───────────────────────────────── */
function buildSystemParts(frameworkText, portfolioSummary, marginContext) {
  const today = new Date().toISOString().slice(0, 10);
  const marginSection = marginContext
    ? `MARGIN & CASH DATA:\n${marginContext}`
    : "MARGIN & CASH DATA:\nNot provided — skip margin checks; omit CAPITAL & MARGIN section from output.";

  const dynamicPart = `---
## LIVE PORTFOLIO DATA (as of ${today})

${portfolioSummary}

${marginSection}

---
## OUTPUT INSTRUCTIONS
- Respond with a single valid HTML fragment (no <!DOCTYPE>, no <html>, no <body> tags).
- Use inline CSS only. No <style> blocks, no external stylesheets.
- Rendered in a sandboxed iframe on dark background #0A0F1E. Text color: #e2e8f0.
- Font: system-ui or monospace for tables.
- Follow the trade plan format defined in this framework exactly.
- No disclaimers, no generic advice warnings. Every line must be actionable.
- If a chart image is attached, analyse it for technical levels, trend, and setup before building the trade plan.`;

  return { frameworkPart: frameworkText, dynamicPart };
}

/* ── Build multimodal message content ────────────────────────── */
function buildUserContent(message, images) {
  if (!images || images.length === 0) return String(message).trim();
  const blocks = [];
  for (const img of images) {
    if (img.media_type && img.data) {
      blocks.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
    }
  }
  blocks.push({ type: "text", text: String(message).trim() });
  return blocks;
}

/* ── Call Anthropic API ──────────────────────────────────────── */
function callAnthropic(frameworkPart, dynamicPart, messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      system: [
        { type: "text", text: frameworkPart, cache_control: { type: "ephemeral" } },
        { type: "text", text: dynamicPart },
      ],
      messages,
    });

    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta":    "prompt-caching-2024-07-31",
          "Content-Length":    Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              const err = new Error(parsed.error.message || "Anthropic API error");
              err.stage = "anthropic_call";
              err.httpStatus = res.statusCode;
              return reject(err);
            }
            const text = parsed.content?.[0]?.text || "";
            if (!text) {
              const err = new Error("Empty response from Claude");
              err.stage = "anthropic_call";
              return reject(err);
            }
            if (parsed.usage) {
              console.log(JSON.stringify({
                level: "INFO", event: "anthropic_usage",
                inputTokens:         parsed.usage.input_tokens,
                cacheCreationTokens: parsed.usage.cache_creation_input_tokens || 0,
                cacheReadTokens:     parsed.usage.cache_read_input_tokens     || 0,
                outputTokens:        parsed.usage.output_tokens,
              }));
            }
            resolve(text);
          } catch (e) {
            const err = new Error("Failed to parse Anthropic response");
            err.stage = "anthropic_call";
            reject(err);
          }
        });
      }
    );
    req.on("error", e => {
      const err = new Error(`Anthropic network error: ${e.message}`);
      err.stage = "anthropic_call";
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

/* ─────────────────────────────────────────────────────────────
   WORKER HANDLER
   Invoked asynchronously (InvocationType: Event) by the API
   handler. Has up to 5-minute Lambda timeout — no API GW limit.
   Writes result (reply or error) to DDB cache so the frontend
   can retrieve it via polling GET /advisor/cache/:cacheKey.
───────────────────────────────────────────────────────────── */
exports.workerHandler = async (payload) => {
  const { cacheKey, accountId, message, history = [], images = [], marginData } = payload;

  console.log(JSON.stringify({
    level: "INFO", event: "worker_start", cacheKey,
    imageCount: images.length,
    imageSizes: images.map(img => ({ type: img.media_type, bytes: Math.round((img.data || "").length * 0.75) })),
  }));

  try {
    const frameworkText    = await getFramework();
    const portfolio        = await fetchPortfolio(accountId);
    const portfolioSummary = buildPortfolioSummary(portfolio);
    const marginContext    = buildMarginContext(marginData || null);
    const { frameworkPart, dynamicPart } = buildSystemParts(frameworkText, portfolioSummary, marginContext);

    const userContent = buildUserContent(message, images);
    const messages = [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: "user", content: userContent },
    ];

    const reply = await callAnthropic(frameworkPart, dynamicPart, messages);
    await writeCache(cacheKey, { reply });

    console.log(JSON.stringify({ level: "INFO", event: "worker_done", cacheKey }));
  } catch (err) {
    console.error(JSON.stringify({ level: "ERROR", event: "worker_failed", cacheKey, stage: err.stage, message: err.message }));
    // Write error to DDB so polling frontend can surface it
    await writeCache(cacheKey, { workerError: true, stage: err.stage || "worker", errorMessage: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────
   API GATEWAY HANDLER
   POST /advisor/chat → checks DDB cache, then fires worker
     async and returns 202 { jobId, status: "pending" }.
   GET  /advisor/cache/:cacheKey → returns cached reply or
     error; 404 means still pending.
───────────────────────────────────────────────────────────── */
exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  const path   = event.rawPath || event.path || "";

  /* ── GET /advisor/cache/:cacheKey ─────────────────────────── */
  if (method === "GET" && path.startsWith("/advisor/cache/")) {
    try {
      const ctx = await resolveCtxCached(event);
      assertRead(ctx, "advisor");

      const cacheKey = path.replace("/advisor/cache/", "").trim();
      if (!cacheKey) return badRequest("cacheKey is required");

      const item = await readCache(cacheKey);
      if (!item) return json(404, { status: "pending", message: "Not ready yet" });

      // Worker wrote an error
      if (item.workerError) {
        return json(500, { error: true, stage: item.stage, message: item.errorMessage, cacheKey });
      }

      return json(200, { reply: item.reply, cacheKey, cached: true });
    } catch (err) {
      return json(err.statusCode || 500, { message: err.message || "Internal server error" });
    }
  }

  /* ── POST /advisor/chat ──────────────────────────────────── */
  if (method === "POST" && path === "/advisor/chat") {
    try {
      const ctx = await resolveCtxCached(event);
      assertRead(ctx, "advisor");

      const body = event.body ? JSON.parse(event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString()
        : event.body
      ) : {};

      const { message, history = [], marginData, images = [] } = body;
      if (!message || !String(message).trim()) return badRequest("message is required");

      if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY === "REPLACE") {
        return json(500, { error: true, stage: "config", message: "Advisor service not configured (missing API key)" });
      }

      const cacheKey = buildCacheKey(ctx.accountId, message, history, images);

      // DDB cache hit — return immediately, no Claude call needed
      const cached = await readCache(cacheKey);
      if (cached) {
        if (cached.workerError) {
          return json(500, { error: true, stage: cached.stage, message: cached.errorMessage, cacheKey });
        }
        return json(200, { reply: cached.reply, cacheKey, cached: true });
      }

      // Fire worker Lambda asynchronously — returns immediately (< 200ms)
      console.log(JSON.stringify({
        level: "INFO", event: "advisor_dispatch",
        accountId: ctx.accountId, cacheKey,
        imageCount: images.length,
        imageSizes: images.map(img => ({ type: img.media_type, bytes: Math.round((img.data || "").length * 0.75) })),
      }));

      await lambda.send(new InvokeCommand({
        FunctionName:   ADVISOR_WORKER_FUNCTION,
        InvocationType: "Event", // fire-and-forget
        Payload:        JSON.stringify({ cacheKey, accountId: ctx.accountId, message, history, images, marginData }),
      }));

      // 202 Accepted — frontend polls GET /advisor/cache/:cacheKey
      return json(202, { jobId: cacheKey, status: "pending" });

    } catch (err) {
      return json(err.statusCode || 500, {
        error: true,
        stage: err.stage || "unknown",
        message: err.message || "Internal server error",
      });
    }
  }

  return json(404, { message: "Not found" });
};
