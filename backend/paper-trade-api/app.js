"use strict";

/**
 * PaperTradeApi — Lambda handler for finVault Paper Trading.
 *
 * All orders are mode=PAPER. This Lambda is intentionally separate from any
 * future LiveTradeApi — shared nothing, separate table, separate routes.
 *
 * Routes:
 *   GET    /paper-trade/staged          → list STAGED orders for account
 *   POST   /paper-trade/staged          → stage a new order (pre-IBKR)
 *   DELETE /paper-trade/staged/{id}     → discard a staged order
 *   POST   /paper-trade/submit/{id}     → confirm + submit staged order to IBKR
 *   GET    /paper-trade/orders          → order history (SUBMITTED / FILLED / CANCELLED / REJECTED)
 *   POST   /paper-trade/status/{id}     → poll IBKR for fill update on a submitted order
 *
 * IBKR integration:
 *   - OAuth 1.0a with RSA-SHA256 signing (IBKR REST API requirement)
 *   - Credentials from Lambda env vars (Secrets Manager migration path documented)
 *   - Every IBKR call goes through ibkrRequest() which:
 *       1. Builds a structured audit log entry BEFORE the call
 *       2. Captures the full response (status, headers summary, body)
 *       3. Logs success or failure with correlation IDs
 *       4. Stores the audit entry on the DynamoDB trade record
 *
 * Audit trail design:
 *   - ibkrAuditLog[] array is accumulated per Lambda invocation
 *   - Each entry: { ts, step, method, url, requestSummary, status, success, response/error, durationMs }
 *   - Written to DynamoDB on the trade record under `ibkrAuditLog`
 *   - CloudWatch structured JSON logs contain identical data for external tooling
 */

const crypto = require("crypto");
const { DynamoDBClient }      = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const { resolveContext, assertWrite, assertRead } = require("finvault-shared/resolveContext");

// ── DynamoDB ──────────────────────────────────────────────────────────────────
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

// ── Environment ───────────────────────────────────────────────────────────────
// IBKR credentials are plain Lambda env vars for now.
// TODO(secrets-manager): replace these four reads with a single
//   GetSecretValueCommand("finvault/ibkr-paper") call and parse the JSON secret.
const PAPER_TRADES_TABLE       = process.env.PAPER_TRADES_TABLE        || "PaperTrades";
const IBKR_BASE_URL            = (process.env.IBKR_BASE_URL            || "https://api.ibkr.com/v1/api").replace(/\/$/, "");
const IBKR_PAPER_ACCOUNT_ID    = process.env.IBKR_PAPER_ACCOUNT_ID     || "";
const IBKR_PAPER_CONSUMER_KEY  = process.env.IBKR_PAPER_CONSUMER_KEY   || "";
// RSA private key stored as base64-encoded PEM in the env var
const IBKR_PAPER_PRIVATE_KEY_B64 = process.env.IBKR_PAPER_PRIVATE_KEY  || "";

const TRADE_MODE = "PAPER";  // hard-coded — this Lambda never writes LIVE records

// ── CORS ──────────────────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Account-Id",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
}

function json(statusCode, body) {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(body) };
}

// ── ID generation ─────────────────────────────────────────────────────────────
function newTradeId() {
  const now  = new Date();
  const date = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 17); // YYYYMMDDHHMMSSmmm
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `PAPER_${date}_${rand}`;
}

// ── Structured logger ─────────────────────────────────────────────────────────
// Emits JSON lines to CloudWatch so they can be queried with Insights / filtered
// by tradeId, accountId, or ibkrStep.
function log(level, event, fields = {}) {
  console[level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log"](
    JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields })
  );
}

// ── OAuth 1.0a / RSA-SHA256 signing (IBKR requirement) ───────────────────────
/**
 * buildOAuthHeader — constructs the OAuth 1.0a Authorization header for IBKR.
 *
 * IBKR uses OAuth 1.0a with RSA-SHA256 (not HMAC). The signature covers:
 *   oauth_consumer_key, oauth_nonce, oauth_signature_method,
 *   oauth_timestamp, oauth_token (empty for 2-legged), oauth_version,
 *   + request method + URL + sorted query/body params.
 *
 * @param {string} method   HTTP method (uppercase)
 * @param {string} url      Full request URL (without query string)
 * @param {object} params   Additional OAuth or request params to include in sig
 * @returns {string}        Value for the Authorization header
 */
function buildOAuthHeader(method, url, params = {}) {
  if (!IBKR_PAPER_CONSUMER_KEY) {
    throw ibkrConfigError("IBKR_PAPER_CONSUMER_KEY is not configured");
  }
  if (!IBKR_PAPER_PRIVATE_KEY_B64) {
    throw ibkrConfigError("IBKR_PAPER_PRIVATE_KEY is not configured");
  }

  const privateKeyPem = Buffer.from(IBKR_PAPER_PRIVATE_KEY_B64, "base64").toString("utf-8");

  const oauthParams = {
    oauth_consumer_key:     IBKR_PAPER_CONSUMER_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "RSA-SHA256",
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_token:            "",   // 2-legged OAuth — no access token
    oauth_version:          "1.0",
    ...params,
  };

  // Percent-encode helper (RFC 3986)
  const pct = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

  // Build the signature base string
  const sortedParams = Object.entries(oauthParams)
    .filter(([, v]) => v !== "")       // exclude empty oauth_token from sig
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${pct(k)}=${pct(v)}`)
    .join("&");

  const signatureBase = [
    method.toUpperCase(),
    pct(url),
    pct(sortedParams),
  ].join("&");

  // Sign with RSA private key
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signatureBase);
  const signature = signer.sign(privateKeyPem, "base64");

  // Build Authorization header (include oauth_token even if empty — IBKR expects it)
  const headerParams = { ...oauthParams, oauth_token: "", oauth_signature: signature };
  const headerValue = "OAuth " + Object.entries(headerParams)
    .map(([k, v]) => `${pct(k)}="${pct(v)}"`)
    .join(", ");

  return headerValue;
}

function ibkrConfigError(msg) {
  const err = new Error(msg);
  err.isIbkrConfigError = true;
  err.statusCode = 503;
  return err;
}

// ── IBKR HTTP client with full audit logging ──────────────────────────────────
/**
 * ibkrRequest — makes one authenticated call to the IBKR REST API.
 *
 * Audit entry structure written to both CloudWatch and DynamoDB:
 * {
 *   ts:             ISO timestamp of call start
 *   step:           human label e.g. "secdef_search", "place_order"
 *   method:         "GET" | "POST"
 *   url:            full URL called
 *   requestSummary: sanitised snapshot of what was sent (no auth headers)
 *   durationMs:     round-trip time
 *   httpStatus:     IBKR HTTP response status
 *   success:        boolean
 *   response:       parsed response body (on success)
 *   error:          error message + type (on failure)
 * }
 *
 * @param {object}   opts
 * @param {string}   opts.step      audit label
 * @param {string}   opts.method    HTTP method
 * @param {string}   opts.path      path relative to IBKR_BASE_URL
 * @param {object}   [opts.body]    request body (JSON)
 * @param {object}   [opts.query]   query string params
 * @param {string}   opts.tradeId   for correlation in logs
 * @param {string}   opts.accountId for correlation in logs
 * @param {object[]} auditLog       mutable array — audit entry is pushed here
 * @returns {object} parsed IBKR response body
 * @throws  enriched Error with .ibkrStep, .httpStatus, .ibkrBody
 */
async function ibkrRequest({ step, method, path, body, query, tradeId, accountId }, auditLog) {
  const qs  = query ? "?" + new URLSearchParams(query).toString() : "";
  const url = `${IBKR_BASE_URL}${path}`;
  const urlWithQs = `${url}${qs}`;
  const startTs = new Date().toISOString();
  const startMs = Date.now();

  const requestSummary = {
    method,
    url: urlWithQs,
    ...(body ? { body } : {}),
  };

  log("INFO", "ibkr_request_start", {
    tradeId, accountId, step, method, url: urlWithQs,
    body: body || null,
  });

  let authHeader;
  try {
    authHeader = buildOAuthHeader(method, url, {});
  } catch (e) {
    const auditEntry = {
      ts: startTs, step, method, url: urlWithQs,
      requestSummary, durationMs: Date.now() - startMs,
      success: false,
      error: { message: e.message, type: "OAuthSigningError" },
    };
    auditLog.push(auditEntry);
    log("ERROR", "ibkr_oauth_signing_failed", { tradeId, accountId, step, error: e.message });
    throw e;
  }

  const fetchOpts = {
    method,
    headers: {
      "Authorization": authHeader,
      "Content-Type":  "application/json",
      "User-Agent":    "finVault/1.0 PaperTradeApi",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  let httpRes, rawText, parsed;

  try {
    httpRes  = await fetch(urlWithQs, fetchOpts);
    rawText  = await httpRes.text();
    const durationMs = Date.now() - startMs;

    // Try to parse JSON; keep raw text if not JSON
    try { parsed = JSON.parse(rawText); } catch { parsed = rawText; }

    const success = httpRes.ok;
    const auditEntry = {
      ts:             startTs,
      step,
      method,
      url:            urlWithQs,
      requestSummary,
      durationMs,
      httpStatus:     httpRes.status,
      success,
      ...(success
        ? { response: parsed }
        : { error: { message: `HTTP ${httpRes.status}`, type: "IbkrHttpError", body: parsed } }
      ),
    };
    auditLog.push(auditEntry);

    if (success) {
      log("INFO", "ibkr_request_success", {
        tradeId, accountId, step, httpStatus: httpRes.status, durationMs, response: parsed,
      });
      return parsed;
    }

    // HTTP error from IBKR — extract their error message when available
    const ibkrMsg = (typeof parsed === "object" && parsed !== null)
      ? (parsed.error || parsed.message || JSON.stringify(parsed))
      : rawText;

    log("ERROR", "ibkr_request_http_error", {
      tradeId, accountId, step, httpStatus: httpRes.status, durationMs,
      ibkrBody: parsed, ibkrMessage: ibkrMsg,
    });

    const err = new Error(`IBKR ${step} failed: HTTP ${httpRes.status} — ${ibkrMsg}`);
    err.ibkrStep    = step;
    err.httpStatus  = httpRes.status;
    err.ibkrBody    = parsed;
    err.statusCode  = httpRes.status >= 500 ? 502 : 422;
    throw err;

  } catch (e) {
    // Network / timeout errors (fetch itself threw)
    if (!httpRes) {
      const durationMs = Date.now() - startMs;
      const auditEntry = {
        ts: startTs, step, method, url: urlWithQs,
        requestSummary, durationMs,
        success: false,
        error: { message: e.message, type: "NetworkError" },
      };
      auditLog.push(auditEntry);
      log("ERROR", "ibkr_request_network_error", { tradeId, accountId, step, durationMs, error: e.message });
      const wrapped = new Error(`IBKR ${step} network error: ${e.message}`);
      wrapped.ibkrStep   = step;
      wrapped.statusCode = 502;
      throw wrapped;
    }
    // Re-throw errors we already enriched above
    throw e;
  }
}

// ── IBKR conId resolution (options) ──────────────────────────────────────────
/**
 * resolveOptionConId — resolves the IBKR numeric contract ID for a specific
 * option contract (symbol + expiry + strike + right).
 *
 * Flow:
 *   1. POST /iserver/secdef/search → get contracts for the symbol
 *   2. POST /iserver/secdef/secdefopt → narrow to the specific expiry/strike/right
 *
 * Both steps are individually audited.
 */
async function resolveOptionConId({ ticker, expiry, strike, right }, tradeId, accountId, auditLog) {
  log("INFO", "ibkr_conid_resolution_start", { tradeId, accountId, ticker, expiry, strike, right });

  // Step 1 — search for the symbol to confirm it exists and get base info
  const searchRes = await ibkrRequest({
    step:      "secdef_search",
    method:    "POST",
    path:      "/iserver/secdef/search",
    body:      { symbol: ticker, secType: "OPT", name: false },
    tradeId,   accountId,
  }, auditLog);

  if (!Array.isArray(searchRes) || searchRes.length === 0) {
    const err = new Error(`IBKR secdef/search returned no results for ${ticker}`);
    err.ibkrStep   = "secdef_search";
    err.statusCode = 422;
    log("ERROR", "ibkr_conid_no_symbol", { tradeId, accountId, ticker, searchRes });
    throw err;
  }

  // Step 2 — get the specific contract (expiry YYYYMMDD, strike as number, right P/C)
  // IBKR expiry format: YYYYMMDD
  const ibkrExpiry = expiry.replace(/-/g, "");
  const secdefRes  = await ibkrRequest({
    step:   "secdef_option",
    method: "POST",
    path:   "/iserver/secdef/secdefopt",
    body:   {
      symbol:   ticker,
      currency: "USD",
      expiry:   ibkrExpiry,
      strike:   String(strike),
      right:    right,          // "P" for put, "C" for call
    },
    tradeId, accountId,
  }, auditLog);

  // Response is an array of contract objects; take the first match
  const contracts = Array.isArray(secdefRes) ? secdefRes : (secdefRes?.contracts || []);
  if (!contracts.length) {
    const err = new Error(`No IBKR contract found for ${ticker} ${right} ${strike} exp ${expiry}`);
    err.ibkrStep   = "secdef_option";
    err.statusCode = 422;
    log("ERROR", "ibkr_conid_no_contract", { tradeId, accountId, ticker, expiry, strike, right });
    throw err;
  }

  const conId = contracts[0].conid || contracts[0].conId;
  if (!conId) {
    const err = new Error(`IBKR contract response missing conid for ${ticker} ${expiry} ${strike}`);
    err.ibkrStep   = "secdef_option";
    err.statusCode = 422;
    throw err;
  }

  log("INFO", "ibkr_conid_resolved", { tradeId, accountId, ticker, expiry, strike, right, conId });
  return Number(conId);
}

// ── IBKR order placement with 2-step confirm handling ────────────────────────
/**
 * placeIbkrOrder — submits an order and handles IBKR's 2-step confirmation.
 *
 * IBKR may respond to POST /orders with a list of messages requiring
 * re-confirmation (e.g. margin warnings). This is handled transparently by
 * auto-replying to each message with `{ confirmed: true }`.
 * For paper trading this is always safe; for live trading a human confirmation
 * step should be inserted before this function is called.
 *
 * Returns: { orderId, orderStatus }
 */
async function placeIbkrOrder({ conId, strategy, quantity, orderType, limitPrice }, tradeId, accountId, auditLog) {
  if (!IBKR_PAPER_ACCOUNT_ID) {
    throw ibkrConfigError("IBKR_PAPER_ACCOUNT_ID is not configured");
  }

  // Map strategy to IBKR order fields
  // SELL_PUT → sell to open, action=SELL, secType=OPT
  // BUY_STOCK → buy, action=BUY, secType=STK
  const isSellPut = strategy === "SELL_PUT";

  const orderPayload = {
    acctId:     IBKR_PAPER_ACCOUNT_ID,
    conid:      conId,
    orderType:  orderType === "MKT" ? "MKT" : "LMT",
    side:       isSellPut ? "SELL" : "BUY",
    quantity:   quantity,
    tif:        "GTC",       // Good Till Cancelled — wheel strategy default
    ...(orderType !== "MKT" ? { price: limitPrice } : {}),
  };

  log("INFO", "ibkr_place_order_start", { tradeId, accountId, strategy, conId, orderPayload });

  let placeRes = await ibkrRequest({
    step:   "place_order",
    method: "POST",
    path:   `/iserver/account/${IBKR_PAPER_ACCOUNT_ID}/orders`,
    body:   { orders: [orderPayload] },
    tradeId, accountId,
  }, auditLog);

  // IBKR 2-step confirm: if the response is an array of {id, message} objects,
  // each message must be confirmed before the order is actually placed.
  if (Array.isArray(placeRes) && placeRes[0]?.id && placeRes[0]?.message) {
    log("INFO", "ibkr_order_needs_confirmation", {
      tradeId, accountId,
      messages: placeRes.map((m) => ({ id: m.id, message: m.message })),
    });

    // Confirm each message in sequence
    for (const msg of placeRes) {
      if (!msg.id) continue;
      placeRes = await ibkrRequest({
        step:   `confirm_order_reply_${msg.id}`,
        method: "POST",
        path:   `/iserver/reply/${msg.id}`,
        body:   { confirmed: true },
        tradeId, accountId,
      }, auditLog);
    }
  }

  // After confirmation(s), response should contain the placed order
  const placed = Array.isArray(placeRes) ? placeRes[0] : placeRes;
  const orderId     = placed?.orderId || placed?.order_id || placed?.id;
  const orderStatus = placed?.order_status || placed?.status || "SUBMITTED";

  if (!orderId) {
    log("WARN", "ibkr_order_no_id_in_response", { tradeId, accountId, placeRes });
  }

  log("INFO", "ibkr_place_order_success", { tradeId, accountId, orderId, orderStatus });
  return { orderId: String(orderId || "UNKNOWN"), orderStatus };
}

// ── IBKR order status poll ────────────────────────────────────────────────────
async function pollIbkrOrderStatus(ibkrOrderId, tradeId, accountId, auditLog) {
  const res = await ibkrRequest({
    step:   "poll_order_status",
    method: "GET",
    path:   `/iserver/account/${IBKR_PAPER_ACCOUNT_ID}/order/status/${ibkrOrderId}`,
    tradeId, accountId,
  }, auditLog);

  // Normalise status — IBKR uses strings like "Filled", "Submitted", "Cancelled"
  const raw    = (res?.status || res?.order_status || "").toLowerCase();
  const status = raw.includes("fill")   ? "FILLED"
               : raw.includes("cancel") ? "CANCELLED"
               : raw.includes("reject") ? "REJECTED"
               : "SUBMITTED";
  const fillPrice = res?.avgPrice || res?.avg_price || null;

  return { status, fillPrice, raw, ibkrResponse: res };
}

// ── DynamoDB helpers ──────────────────────────────────────────────────────────
async function getStagedOrder(accountId, tradeId) {
  const res = await ddb.send(new GetCommand({
    TableName: PAPER_TRADES_TABLE,
    Key: { accountId, tradeId },
  }));
  return res.Item || null;
}

async function listOrdersByStatus(accountId, statusFilter) {
  // GSI: PK = mode#status, SK = createdAt
  // We query for this account's orders filtered by mode+status
  const res = await ddb.send(new QueryCommand({
    TableName:                PAPER_TRADES_TABLE,
    IndexName:                "ModeStatusIndex",
    KeyConditionExpression:   "#pk = :pk",
    FilterExpression:         "accountId = :accountId",
    ExpressionAttributeNames: { "#pk": "modeStatus" },
    ExpressionAttributeValues: {
      ":pk":        `${TRADE_MODE}#${statusFilter}`,
      ":accountId": accountId,
    },
    ScanIndexForward: false,   // newest first
  }));
  return res.Items || [];
}

async function listOrdersByStatuses(accountId, statuses) {
  const results = await Promise.all(statuses.map((s) => listOrdersByStatus(accountId, s)));
  return results.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * appendAuditLog — merges new audit entries into the trade record's ibkrAuditLog
 * and updates the status / ibkr fields atomically.
 */
async function updateTradeRecord(accountId, tradeId, fields, newAuditEntries) {
  const now = new Date().toISOString();
  const updates = { updatedAt: now, ...fields };

  // Build UpdateExpression dynamically
  const setExprs   = [];
  const attrNames  = {};
  const attrValues = {};

  for (const [k, v] of Object.entries(updates)) {
    setExprs.push(`#${k} = :${k}`);
    attrNames[`#${k}`]  = k;
    attrValues[`:${k}`] = v;
  }

  // Append audit entries using list_append
  if (newAuditEntries && newAuditEntries.length > 0) {
    setExprs.push("#ibkrAuditLog = list_append(if_not_exists(#ibkrAuditLog, :emptyList), :newEntries)");
    attrNames["#ibkrAuditLog"]  = "ibkrAuditLog";
    attrValues[":emptyList"]    = [];
    attrValues[":newEntries"]   = newAuditEntries;
  }

  await ddb.send(new UpdateCommand({
    TableName:                PAPER_TRADES_TABLE,
    Key:                      { accountId, tradeId },
    UpdateExpression:         "SET " + setExprs.join(", "),
    ExpressionAttributeNames: attrNames,
    ExpressionAttributeValues: attrValues,
  }));
}

// ── Route handlers ────────────────────────────────────────────────────────────

// GET /paper-trade/staged
async function handleListStaged(ctx) {
  log("INFO", "list_staged_orders", { accountId: ctx.accountId });
  const orders = await listOrdersByStatus(ctx.accountId, "STAGED");
  return json(200, { mode: TRADE_MODE, orders });
}

// POST /paper-trade/staged
async function handleStageOrder(ctx, body) {
  const { ticker, strategy, strike, expiry, quantity, orderType, limitPrice, scanId, source, notes } = body || {};

  // Validation
  const errors = [];
  if (!ticker)                              errors.push("ticker is required");
  if (!["SELL_PUT"].includes(strategy))     errors.push("strategy must be SELL_PUT");
  if (!strike || isNaN(Number(strike)))     errors.push("strike must be a number");
  if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry))
                                            errors.push("expiry must be YYYY-MM-DD");
  if (!quantity || isNaN(Number(quantity))) errors.push("quantity must be a number");
  if (!["LMT", "MKT"].includes(orderType))  errors.push("orderType must be LMT or MKT");
  if (orderType === "LMT" && (limitPrice == null || isNaN(Number(limitPrice))))
                                            errors.push("limitPrice is required for LMT orders");

  if (errors.length) {
    log("WARN", "stage_order_validation_failed", { accountId: ctx.accountId, errors, body });
    return json(400, { error: "Validation failed", details: errors });
  }

  const tradeId  = newTradeId();
  const now      = new Date().toISOString();

  const item = {
    accountId,
    tradeId,
    mode:       TRADE_MODE,
    modeStatus: `${TRADE_MODE}#STAGED`,
    status:     "STAGED",
    createdAt:  now,
    updatedAt:  now,
    source:     source || "wheel-scan",
    scanId:     scanId || null,
    ticker:     ticker.toUpperCase().trim(),
    strategy,
    strike:     Number(strike),
    expiry,
    quantity:   Number(quantity),
    orderType,
    limitPrice: orderType === "LMT" ? Number(limitPrice) : null,
    notes:      notes || null,
    ibkrAuditLog: [],
  };

  // Fix: use ctx.accountId not the block-scoped destructure above
  item.accountId = ctx.accountId;

  await ddb.send(new PutCommand({ TableName: PAPER_TRADES_TABLE, Item: item }));

  log("INFO", "order_staged", {
    accountId: ctx.accountId, tradeId, ticker: item.ticker,
    strategy, strike: item.strike, expiry, quantity: item.quantity,
  });

  return json(201, { message: "Order staged successfully", tradeId, order: item });
}

// DELETE /paper-trade/staged/{tradeId}
async function handleDiscardStaged(ctx, tradeId) {
  const order = await getStagedOrder(ctx.accountId, tradeId);
  if (!order) {
    return json(404, { error: "Staged order not found" });
  }
  if (order.status !== "STAGED") {
    log("WARN", "discard_non_staged_order", { accountId: ctx.accountId, tradeId, status: order.status });
    return json(409, { error: `Cannot discard order in status ${order.status}` });
  }

  await updateTradeRecord(ctx.accountId, tradeId, {
    status:     "CANCELLED",
    modeStatus: `${TRADE_MODE}#CANCELLED`,
    cancelledAt: new Date().toISOString(),
    cancelReason: "Discarded by user before submission",
  }, []);

  log("INFO", "order_discarded", { accountId: ctx.accountId, tradeId });
  return json(200, { message: "Order discarded", tradeId });
}

// POST /paper-trade/submit/{tradeId}
async function handleSubmitOrder(ctx, tradeId) {
  const order = await getStagedOrder(ctx.accountId, tradeId);
  if (!order) {
    return json(404, { error: "Staged order not found" });
  }
  if (order.status !== "STAGED") {
    log("WARN", "submit_non_staged_order", { accountId: ctx.accountId, tradeId, status: order.status });
    return json(409, { error: `Order is already in status ${order.status} — cannot resubmit` });
  }

  const auditLog = [];

  log("INFO", "order_submit_start", {
    accountId: ctx.accountId, tradeId,
    ticker: order.ticker, strategy: order.strategy,
    strike: order.strike, expiry: order.expiry, quantity: order.quantity,
  });

  // Mark as SUBMITTING immediately so double-clicks don't race
  await updateTradeRecord(ctx.accountId, tradeId, {
    status:      "SUBMITTING",
    modeStatus:  `${TRADE_MODE}#SUBMITTING`,
    submittingAt: new Date().toISOString(),
  }, []);

  try {
    // Step 1 — resolve IBKR contract ID
    const right = order.strategy === "SELL_PUT" ? "P" : "C";
    const conId = await resolveOptionConId(
      { ticker: order.ticker, expiry: order.expiry, strike: order.strike, right },
      tradeId, ctx.accountId, auditLog
    );

    // Step 2 — place the order
    const { orderId, orderStatus } = await placeIbkrOrder(
      {
        conId,
        strategy:   order.strategy,
        quantity:   order.quantity,
        orderType:  order.orderType,
        limitPrice: order.limitPrice,
      },
      tradeId, ctx.accountId, auditLog
    );

    // Step 3 — persist success
    await updateTradeRecord(ctx.accountId, tradeId, {
      status:       "SUBMITTED",
      modeStatus:   `${TRADE_MODE}#SUBMITTED`,
      ibkrConId:    conId,
      ibkrOrderId:  orderId,
      ibkrStatus:   orderStatus,
      submittedAt:  new Date().toISOString(),
    }, auditLog);

    log("INFO", "order_submitted_success", {
      accountId: ctx.accountId, tradeId, orderId, orderStatus, conId,
      auditSteps: auditLog.map((e) => ({ step: e.step, success: e.success, durationMs: e.durationMs })),
    });

    return json(200, {
      message:     "Order submitted to IBKR successfully",
      tradeId,
      ibkrOrderId: orderId,
      ibkrStatus:  orderStatus,
      auditSteps:  auditLog.map((e) => ({ step: e.step, success: e.success, durationMs: e.durationMs, httpStatus: e.httpStatus })),
    });

  } catch (err) {
    // Persist failure — roll back to STAGED so user can retry or discard
    const failureInfo = {
      message:   err.message,
      ibkrStep:  err.ibkrStep  || null,
      httpStatus: err.httpStatus || null,
      ibkrBody:  err.ibkrBody  || null,
    };

    await updateTradeRecord(ctx.accountId, tradeId, {
      status:           "STAGED",      // revert — still actionable
      modeStatus:       `${TRADE_MODE}#STAGED`,
      lastSubmitError:  failureInfo,
      lastSubmitAt:     new Date().toISOString(),
    }, auditLog);

    log("ERROR", "order_submit_failed", {
      accountId: ctx.accountId, tradeId,
      error:     err.message,
      ibkrStep:  err.ibkrStep  || null,
      httpStatus: err.httpStatus || null,
      auditSteps: auditLog.map((e) => ({ step: e.step, success: e.success, durationMs: e.durationMs })),
    });

    // Surface a clear error to the UI
    const userMessage = err.isIbkrConfigError
      ? `IBKR is not configured: ${err.message}`
      : err.ibkrStep
        ? `IBKR rejected the order at step '${err.ibkrStep}': ${err.message}`
        : `Order submission failed: ${err.message}`;

    return json(err.statusCode || 502, {
      error:      userMessage,
      ibkrStep:   err.ibkrStep  || null,
      tradeId,
      auditSteps: auditLog.map((e) => ({ step: e.step, success: e.success, durationMs: e.durationMs, httpStatus: e.httpStatus })),
    });
  }
}

// GET /paper-trade/orders
async function handleListOrders(ctx) {
  log("INFO", "list_order_history", { accountId: ctx.accountId });
  const orders = await listOrdersByStatuses(ctx.accountId, ["SUBMITTED", "FILLED", "CANCELLED", "REJECTED"]);
  return json(200, { mode: TRADE_MODE, orders });
}

// POST /paper-trade/status/{tradeId}
async function handlePollStatus(ctx, tradeId) {
  const order = await getStagedOrder(ctx.accountId, tradeId);
  if (!order) {
    return json(404, { error: "Order not found" });
  }
  if (order.status !== "SUBMITTED") {
    return json(409, { error: `Order is in status ${order.status} — only SUBMITTED orders can be polled` });
  }
  if (!order.ibkrOrderId) {
    return json(422, { error: "Order has no IBKR order ID — cannot poll status" });
  }

  const auditLog = [];

  log("INFO", "poll_order_status_start", { accountId: ctx.accountId, tradeId, ibkrOrderId: order.ibkrOrderId });

  try {
    const { status, fillPrice, raw, ibkrResponse } = await pollIbkrOrderStatus(
      order.ibkrOrderId, tradeId, ctx.accountId, auditLog
    );

    const updates = {
      status,
      modeStatus: `${TRADE_MODE}#${status}`,
      ibkrStatus: raw,
      ...(status === "FILLED" ? {
        fillPrice:  fillPrice !== null ? Number(fillPrice) : null,
        filledAt:   new Date().toISOString(),
      } : {}),
    };

    await updateTradeRecord(ctx.accountId, tradeId, updates, auditLog);

    log("INFO", "poll_order_status_success", {
      accountId: ctx.accountId, tradeId, status, fillPrice, ibkrStatus: raw,
    });

    return json(200, { tradeId, status, fillPrice, ibkrStatus: raw, ibkrResponse });

  } catch (err) {
    await updateTradeRecord(ctx.accountId, tradeId, {
      lastPollError: { message: err.message, ts: new Date().toISOString() },
    }, auditLog);

    log("ERROR", "poll_order_status_failed", {
      accountId: ctx.accountId, tradeId, error: err.message,
    });

    return json(err.statusCode || 502, {
      error:   `Failed to poll IBKR order status: ${err.message}`,
      tradeId,
    });
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const method  = (event.requestContext?.http?.method || event.httpMethod || "GET").toUpperCase();
  const rawPath = event.rawPath || event.path || "/";

  if (method === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };

  // Parse body once
  let body = null;
  if (event.body) {
    try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body); }
    catch { return json(400, { error: "Invalid JSON body" }); }
  }

  // Extract tradeId from path — last segment after /staged/ or /submit/ or /status/
  const pathParts = rawPath.split("/").filter(Boolean);
  const lastSegment = pathParts[pathParts.length - 1];
  const tradeIdFromPath = /^PAPER_/.test(lastSegment) ? lastSegment : null;

  log("INFO", "request_received", { method, rawPath, tradeIdFromPath });

  try {
    const ctx = await resolveContext(event);
    assertRead(ctx, "paperTrading");

    // ── Routes ──
    if (method === "GET"    && rawPath.endsWith("/paper-trade/staged"))
      return handleListStaged(ctx);

    if (method === "POST"   && rawPath.endsWith("/paper-trade/staged"))
      { assertWrite(ctx, "paperTrading"); return handleStageOrder(ctx, body); }

    if (method === "DELETE" && tradeIdFromPath && rawPath.includes("/paper-trade/staged/"))
      { assertWrite(ctx, "paperTrading"); return handleDiscardStaged(ctx, tradeIdFromPath); }

    if (method === "POST"   && tradeIdFromPath && rawPath.includes("/paper-trade/submit/"))
      { assertWrite(ctx, "paperTrading"); return handleSubmitOrder(ctx, tradeIdFromPath); }

    if (method === "GET"    && rawPath.endsWith("/paper-trade/orders"))
      return handleListOrders(ctx);

    if (method === "POST"   && tradeIdFromPath && rawPath.includes("/paper-trade/status/"))
      return handlePollStatus(ctx, tradeIdFromPath);

    return json(404, { error: "Route not found" });

  } catch (err) {
    if (err.statusCode === 401) return json(401, { error: "Unauthorized" });
    if (err.statusCode === 403) return json(403, { error: err.message });
    log("ERROR", "unhandled_error", { error: err.message, stack: err.stack });
    return json(500, { error: "Internal server error" });
  }
};
