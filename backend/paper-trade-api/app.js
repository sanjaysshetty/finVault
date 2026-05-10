"use strict";

/**
 * PaperTradeApi — fully internal paper trading engine.
 *
 * No broker integration. Fills and mark-to-market are driven by Black-Scholes
 * using 30-day historical volatility (HV30) calculated from Finnhub daily candles.
 *
 * Supported strategies:
 *   Options : SELL_PUT, BUY_PUT, SELL_CALL, BUY_CALL
 *   Stocks  : BUY_STOCK, SELL_STOCK
 *
 * Routes:
 *   GET    /paper-trade/staged          → list STAGED orders
 *   POST   /paper-trade/staged          → stage a new order
 *   DELETE /paper-trade/staged/{id}     → discard a staged order
 *   PATCH  /paper-trade/staged/{id}     → update limit price (STAGED or SUBMITTED)
 *   POST   /paper-trade/submit/{id}     → submit — fills immediately or parks as SUBMITTED
 *   GET    /paper-trade/orders          → order history
 *   POST   /paper-trade/status/{id}     → manually check fill on a SUBMITTED order
 *   EventBridge schedule (every 15 min) → auto-fill all SUBMITTED limit orders
 *
 * Fill logic:
 *   Market order → fills at current BS / stock price on submission
 *   Limit order  → fills when BS / stock price crosses the limit price
 *   Expired option → EXPIRED with result WORTHLESS or ASSIGNED
 */

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
const PAPER_TRADES_TABLE = process.env.PAPER_TRADES_TABLE || "PaperTrades";
const FINNHUB_API_KEY    = process.env.FINNHUB_API_KEY    || "";
const FINNHUB_BASE       = "https://finnhub.io/api/v1";
const RISK_FREE_RATE     = 0.045; // 4.5% annualized — update once a year
const TRADE_MODE         = "PAPER";

const OPTION_STRATEGIES  = new Set(["SELL_PUT", "BUY_PUT", "SELL_CALL", "BUY_CALL"]);
const STOCK_STRATEGIES   = new Set(["BUY_STOCK", "SELL_STOCK"]);
const ALL_STRATEGIES     = [...OPTION_STRATEGIES, ...STOCK_STRATEGIES];

// ── CORS / response helpers ───────────────────────────────────────────────────
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Account-Id",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
}

function json(statusCode, body) {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(body) };
}

function log(level, event, fields = {}) {
  console[level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log"](
    JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields })
  );
}

function newTradeId() {
  const date = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `PAPER_${date}_${rand}`;
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

// ── Black-Scholes ─────────────────────────────────────────────────────────────

// Cumulative standard normal distribution (Abramowitz & Stegun approximation)
function cnd(x) {
  const a1 =  0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p  = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

// right: "C" for call, "P" for put
function bsPrice(S, K, T, r, sigma, right) {
  if (T <= 0) return right === "C" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  if (right === "C") return S * cnd(d1) - K * Math.exp(-r * T) * cnd(d2);
  return K * Math.exp(-r * T) * cnd(-d2) - S * cnd(-d1);
}

function bsGreeks(S, K, T, r, sigma, right) {
  if (T <= 0) return { delta: right === "C" ? 1 : -1, gamma: 0, theta: 0, vega: 0 };
  const sqrtT = Math.sqrt(T);
  const d1    = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2    = d1 - sigma * sqrtT;
  const npd1  = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  const delta = right === "C" ? cnd(d1) : cnd(d1) - 1;
  const gamma = npd1 / (S * sigma * sqrtT);
  const vega  = S * npd1 * sqrtT / 100;   // per 1% change in vol
  const theta = right === "C"
    ? (-(S * npd1 * sigma) / (2 * sqrtT) - r * K * Math.exp(-r * T) * cnd(d2))  / 365
    : (-(S * npd1 * sigma) / (2 * sqrtT) + r * K * Math.exp(-r * T) * cnd(-d2)) / 365;
  return {
    delta: round4(delta),
    gamma: round4(gamma),
    theta: round4(theta),
    vega:  round4(vega),
  };
}

// Time to expiry in years; options expire at 4 PM ET = 21:00 UTC
function timeToExpiry(expiryDateStr) {
  const expiry = new Date(expiryDateStr + "T21:00:00Z");
  return Math.max((expiry.getTime() - Date.now()) / (365.25 * 24 * 3600 * 1000), 0);
}

// ── Finnhub ───────────────────────────────────────────────────────────────────
async function finnhubGet(path) {
  if (!FINNHUB_API_KEY) {
    throw Object.assign(new Error("FINNHUB_API_KEY not configured"), { statusCode: 503 });
  }
  const res = await fetch(`${FINNHUB_BASE}${path}&token=${FINNHUB_API_KEY}`);
  if (!res.ok) {
    throw Object.assign(new Error(`Finnhub error: HTTP ${res.status} for ${path}`), { statusCode: 502 });
  }
  return res.json();
}

async function fetchStockPrice(ticker) {
  const q = await finnhubGet(`/quote?symbol=${encodeURIComponent(ticker)}`);
  const price = q.c;
  if (!price || price <= 0) {
    throw Object.assign(new Error(`No live price from Finnhub for ${ticker}`), { statusCode: 422 });
  }
  return price;
}

// 30-day historical volatility (annualised) from daily closing prices
async function fetchHV30(ticker) {
  const to   = Math.floor(Date.now() / 1000);
  const from = to - 45 * 86400;   // 45 calendar days → ~30 trading days
  const d    = await finnhubGet(
    `/stock/candle?symbol=${encodeURIComponent(ticker)}&resolution=D&from=${from}&to=${to}`
  );
  if (d.s !== "ok" || !Array.isArray(d.c) || d.c.length < 5) {
    throw Object.assign(new Error(`Insufficient candle data for ${ticker}`), { statusCode: 422 });
  }
  const returns = [];
  for (let i = 1; i < d.c.length; i++) {
    returns.push(Math.log(d.c[i] / d.c[i - 1]));
  }
  const mean     = returns.reduce((s, x) => s + x, 0) / returns.length;
  const variance = returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * 252);
}

// ── Market snapshot ───────────────────────────────────────────────────────────
// Returns the current theoretical price and greeks for any order type.
async function buildSnapshot(order) {
  const stockPrice = await fetchStockPrice(order.ticker);

  if (STOCK_STRATEGIES.has(order.strategy)) {
    return { assetType: "STOCK", stockPrice: round2(stockPrice), marketPrice: round2(stockPrice) };
  }

  // Attempt HV30 from Finnhub candles; fall back to 30% if endpoint is unavailable (free-tier 403).
  let hv30, hvSource;
  try {
    hv30      = await fetchHV30(order.ticker);
    hvSource  = "hv30";
  } catch (_) {
    hv30      = 0.30;
    hvSource  = "default";
  }

  const T      = timeToExpiry(order.expiry);
  const right  = order.right;
  const price  = bsPrice(stockPrice, order.strike, T, RISK_FREE_RATE, hv30, right);
  const greeks = bsGreeks(stockPrice, order.strike, T, RISK_FREE_RATE, hv30, right);

  return {
    assetType:   "OPTION",
    stockPrice:  round2(stockPrice),
    hv30:        round4(hv30),
    hvSource,
    iv:          round4(hv30),
    T:           round4(T),
    marketPrice: round2(price),
    greeks,
  };
}

// ── Fill evaluation ───────────────────────────────────────────────────────────
// Returns { shouldFill, fillPrice, snapshot } or { expired, expiredResult, stockPrice }
async function evaluateFill(order) {
  // Check option expiry first (avoids unnecessary Finnhub candle call)
  if (OPTION_STRATEGIES.has(order.strategy) && timeToExpiry(order.expiry) === 0) {
    const stockPrice = await fetchStockPrice(order.ticker);
    const isAssigned = order.right === "P"
      ? stockPrice < order.strike
      : stockPrice > order.strike;
    return { expired: true, expiredResult: isAssigned ? "ASSIGNED" : "WORTHLESS", stockPrice };
  }

  const snapshot = await buildSnapshot(order);

  if (order.orderType === "MKT") {
    return { shouldFill: true, fillPrice: round2(snapshot.marketPrice), snapshot };
  }

  // LMT: sells fill when market price >= limit; buys fill when market price <= limit
  const isSell  = order.strategy.startsWith("SELL");
  const crossed = isSell
    ? snapshot.marketPrice >= order.limitPrice
    : snapshot.marketPrice <= order.limitPrice;

  return {
    shouldFill: crossed,
    fillPrice:  crossed ? order.limitPrice : null,
    snapshot,
  };
}

// ── DynamoDB helpers ──────────────────────────────────────────────────────────
async function getOrder(accountId, tradeId) {
  const res = await ddb.send(new GetCommand({ TableName: PAPER_TRADES_TABLE, Key: { accountId, tradeId } }));
  return res.Item || null;
}

async function listOrdersByStatus(accountId, statusFilter) {
  const res = await ddb.send(new QueryCommand({
    TableName:                 PAPER_TRADES_TABLE,
    IndexName:                 "ModeStatusIndex",
    KeyConditionExpression:    "#pk = :pk",
    FilterExpression:          "accountId = :accountId",
    ExpressionAttributeNames:  { "#pk": "modeStatus" },
    ExpressionAttributeValues: { ":pk": `${TRADE_MODE}#${statusFilter}`, ":accountId": accountId },
    ScanIndexForward: false,
  }));
  return res.Items || [];
}

async function listOrdersByStatuses(accountId, statuses) {
  const results = await Promise.all(statuses.map((s) => listOrdersByStatus(accountId, s)));
  return results.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// All SUBMITTED orders across all accounts — used by the auto-fill scheduler
async function listAllSubmittedOrders() {
  const res = await ddb.send(new QueryCommand({
    TableName:                 PAPER_TRADES_TABLE,
    IndexName:                 "ModeStatusIndex",
    KeyConditionExpression:    "#pk = :pk",
    ExpressionAttributeNames:  { "#pk": "modeStatus" },
    ExpressionAttributeValues: { ":pk": `${TRADE_MODE}#SUBMITTED` },
  }));
  return res.Items || [];
}

async function updateOrder(accountId, tradeId, fields) {
  const updates    = { updatedAt: new Date().toISOString(), ...fields };
  const setExprs   = [], attrNames = {}, attrValues = {};
  for (const [k, v] of Object.entries(updates)) {
    setExprs.push(`#${k} = :${k}`);
    attrNames[`#${k}`]  = k;
    attrValues[`:${k}`] = v;
  }
  await ddb.send(new UpdateCommand({
    TableName:                 PAPER_TRADES_TABLE,
    Key:                       { accountId, tradeId },
    UpdateExpression:          "SET " + setExprs.join(", "),
    ExpressionAttributeNames:  attrNames,
    ExpressionAttributeValues: attrValues,
  }));
}

// ── Realized P&L ─────────────────────────────────────────────────────────────
function calcRealizedPnl(order, closePrice) {
  const qty        = order.quantity;
  const fill       = order.fillPrice;
  const isSell     = order.strategy.startsWith("SELL");
  const multiplier = OPTION_STRATEGIES.has(order.strategy) ? 100 : 1;
  return round2(isSell
    ? (fill - closePrice) * qty * multiplier   // sold → profit when buyback is cheaper
    : (closePrice - fill) * qty * multiplier); // bought → profit when sell is higher
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleListStaged(ctx) {
  const orders = await listOrdersByStatus(ctx.accountId, "STAGED");
  return json(200, { mode: TRADE_MODE, orders });
}

async function handleStageOrder(ctx, body) {
  const { ticker, strategy, strike, expiry, quantity, orderType, limitPrice, scanId, source, notes } = body || {};

  const errors = [];
  if (!ticker)                               errors.push("ticker is required");
  if (!ALL_STRATEGIES.includes(strategy))    errors.push(`strategy must be one of: ${ALL_STRATEGIES.join(", ")}`);
  if (!quantity || isNaN(Number(quantity)))  errors.push("quantity must be a number");
  if (!["LMT", "MKT"].includes(orderType))  errors.push("orderType must be LMT or MKT");
  if (orderType === "LMT" && (limitPrice == null || isNaN(Number(limitPrice))))
                                             errors.push("limitPrice is required for LMT orders");
  if (OPTION_STRATEGIES.has(strategy)) {
    if (!strike || isNaN(Number(strike)))                           errors.push("strike must be a number");
    if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry))           errors.push("expiry must be YYYY-MM-DD");
  }
  if (errors.length) return json(400, { error: "Validation failed", details: errors });

  const tradeId = newTradeId();
  const now     = new Date().toISOString();
  const right   = OPTION_STRATEGIES.has(strategy) ? (strategy.includes("PUT") ? "P" : "C") : null;

  const item = {
    accountId:   ctx.accountId,
    tradeId,
    mode:        TRADE_MODE,
    modeStatus:  `${TRADE_MODE}#STAGED`,
    status:      "STAGED",
    createdAt:   now,
    updatedAt:   now,
    source:      source || "manual",
    scanId:      scanId || null,
    ticker:      ticker.toUpperCase().trim(),
    strategy,
    right,
    ...(OPTION_STRATEGIES.has(strategy) ? { strike: Number(strike), expiry } : {}),
    quantity:    Number(quantity),
    orderType,
    limitPrice:  orderType === "LMT" ? Number(limitPrice) : null,
    notes:       notes || null,
  };

  await ddb.send(new PutCommand({ TableName: PAPER_TRADES_TABLE, Item: item }));
  log("INFO", "order_staged", { accountId: ctx.accountId, tradeId, ticker: item.ticker, strategy });
  return json(201, { message: "Order staged", tradeId, order: item });
}

async function handleDiscardStaged(ctx, tradeId) {
  const order = await getOrder(ctx.accountId, tradeId);
  if (!order)                     return json(404, { error: "Order not found" });
  if (order.status !== "STAGED")  return json(409, { error: `Cannot discard order in status ${order.status}` });

  await updateOrder(ctx.accountId, tradeId, {
    status:       "CANCELLED",
    modeStatus:   `${TRADE_MODE}#CANCELLED`,
    cancelledAt:  new Date().toISOString(),
    cancelReason: "Discarded by user before submission",
  });
  log("INFO", "order_discarded", { accountId: ctx.accountId, tradeId });
  return json(200, { message: "Order discarded", tradeId });
}

async function handleUpdateLimitPrice(ctx, tradeId, body) {
  const order = await getOrder(ctx.accountId, tradeId);
  if (!order) return json(404, { error: "Order not found" });
  if (!["STAGED", "SUBMITTED"].includes(order.status))
    return json(409, { error: `Cannot update limit price for order in status ${order.status}` });
  if (order.orderType !== "LMT")
    return json(409, { error: "Cannot set a limit price on a market order" });

  const newLimit = Number(body?.limitPrice);
  if (!newLimit || isNaN(newLimit) || newLimit <= 0)
    return json(400, { error: "limitPrice must be a positive number" });

  await updateOrder(ctx.accountId, tradeId, { limitPrice: newLimit });
  log("INFO", "limit_price_updated", { accountId: ctx.accountId, tradeId, newLimit });
  return json(200, { message: "Limit price updated", tradeId, limitPrice: newLimit });
}

async function handleSubmitOrder(ctx, tradeId) {
  const order = await getOrder(ctx.accountId, tradeId);
  if (!order)                     return json(404, { error: "Order not found" });
  if (order.status !== "STAGED")  return json(409, { error: `Order is in status ${order.status} — only STAGED orders can be submitted` });

  log("INFO", "order_submit_start", { accountId: ctx.accountId, tradeId, ticker: order.ticker, strategy: order.strategy });

  try {
    const result = await evaluateFill(order);

    if (result.expired) {
      await updateOrder(ctx.accountId, tradeId, {
        status: "EXPIRED", modeStatus: `${TRADE_MODE}#EXPIRED`,
        expiredAt: new Date().toISOString(),
      });
      return json(422, { error: "Option has already expired — cannot submit" });
    }

    if (result.shouldFill) {
      await updateOrder(ctx.accountId, tradeId, {
        status:       "FILLED",
        modeStatus:   `${TRADE_MODE}#FILLED`,
        fillPrice:    result.fillPrice,
        filledAt:     new Date().toISOString(),
        fillSnapshot: result.snapshot,
      });
      log("INFO", "order_filled_on_submit", { accountId: ctx.accountId, tradeId, fillPrice: result.fillPrice });
      return json(200, {
        message: "Order submitted and filled immediately",
        tradeId, status: "FILLED",
        fillPrice: result.fillPrice, snapshot: result.snapshot,
      });
    }

    // Limit not yet reached — park as SUBMITTED
    await updateOrder(ctx.accountId, tradeId, {
      status:       "SUBMITTED",
      modeStatus:   `${TRADE_MODE}#SUBMITTED`,
      submittedAt:  new Date().toISOString(),
      lastSnapshot: result.snapshot,
    });
    log("INFO", "order_submitted_pending", { accountId: ctx.accountId, tradeId, marketPrice: result.snapshot.marketPrice });
    return json(200, {
      message: "Order submitted — waiting for limit to be reached",
      tradeId, status: "SUBMITTED",
      currentPrice: result.snapshot.marketPrice,
      limitPrice: order.limitPrice,
      snapshot: result.snapshot,
    });

  } catch (err) {
    log("ERROR", "order_submit_failed", { accountId: ctx.accountId, tradeId, error: err.message });
    return json(err.statusCode || 502, { error: err.message, tradeId });
  }
}

async function handleListOrders(ctx) {
  const orders = await listOrdersByStatuses(ctx.accountId, ["SUBMITTED", "FILLED", "CLOSED", "CANCELLED", "EXPIRED"]);
  return json(200, { mode: TRADE_MODE, orders });
}

async function handleClosePosition(ctx, tradeId, body) {
  const order = await getOrder(ctx.accountId, tradeId);
  if (!order)                    return json(404, { error: "Order not found" });
  if (order.status !== "FILLED") return json(409, { error: `Only FILLED positions can be closed (current: ${order.status})` });

  const { orderType, closePrice: rawClose, closeAction, notes: closeNotes } = body || {};
  if (!["MKT", "LMT"].includes(orderType))
    return json(400, { error: "orderType must be MKT (current BS price) or LMT (custom price)" });
  if (orderType === "LMT" && (rawClose == null || isNaN(Number(rawClose)) || Number(rawClose) < 0))
    return json(400, { error: "closePrice is required and must be >= 0 for LMT close" });

  let closePrice, closeSnapshot = null;
  try {
    if (orderType === "MKT") {
      const snapshot = await buildSnapshot(order);
      closePrice     = round2(snapshot.marketPrice);
      closeSnapshot  = snapshot;
    } else {
      closePrice = round2(Number(rawClose));
    }
  } catch (err) {
    return json(err.statusCode || 502, { error: err.message });
  }

  const realizedPnl = calcRealizedPnl(order, closePrice);
  const now = new Date().toISOString();

  await updateOrder(ctx.accountId, tradeId, {
    status:         "CLOSED",
    modeStatus:     `${TRADE_MODE}#CLOSED`,
    closePrice,
    closeOrderType: orderType,
    closedAt:       now,
    realizedPnl,
    ...(closeAction ? { closeAction }  : {}),
    ...(closeNotes  ? { notes: closeNotes } : {}),
    ...(closeSnapshot ? { closeSnapshot } : {}),
  });

  log("INFO", "position_closed", { accountId: ctx.accountId, tradeId, closePrice, realizedPnl, closeAction });

  // On assignment: auto-create a stock position in PaperTrades so it appears in the Positions tab
  if (closeAction === "ASSIGN" && OPTION_STRATEGIES.has(order.strategy)) {
    // SELL_PUT / BUY_CALL assigned → receive shares;  SELL_CALL / BUY_PUT assigned → deliver shares
    const stockStrategy = (order.strategy === "SELL_PUT" || order.strategy === "BUY_CALL")
      ? "BUY_STOCK" : "SELL_STOCK";
    const stockQty      = (order.quantity || 1) * 100;
    const stockTradeId  = newTradeId();

    const stockItem = {
      accountId:     ctx.accountId,
      tradeId:       stockTradeId,
      ticker:        order.ticker,
      strategy:      stockStrategy,
      quantity:      stockQty,
      fillPrice:     round2(order.strike),
      status:        "FILLED",
      modeStatus:    `${TRADE_MODE}#FILLED`,
      mode:          TRADE_MODE,
      orderType:     "LMT",
      source:        "assignment",
      parentTradeId: tradeId,
      notes:         `Assigned from ${order.strategy} · strike $${order.strike}`,
      createdAt:     now,
      filledAt:      now,
      fillSnapshot:  { assetType: "STOCK", stockPrice: round2(order.strike), marketPrice: round2(order.strike) },
    };

    await ddb.send(new PutCommand({ TableName: PAPER_TRADES_TABLE, Item: stockItem }));
    log("INFO", "assignment_stock_created", { accountId: ctx.accountId, stockTradeId, stockStrategy, stockQty, fillPrice: order.strike });

    return json(200, {
      tradeId, status: "CLOSED", closePrice, realizedPnl, closeAction,
      stockPosition: { tradeId: stockTradeId, strategy: stockStrategy, quantity: stockQty, fillPrice: round2(order.strike) },
    });
  }

  return json(200, { tradeId, status: "CLOSED", closePrice, realizedPnl, closeAction });
}

async function handleGetQuote(ctx, ticker) {
  if (!ticker) return json(400, { error: "ticker is required" });
  try {
    const price = await fetchStockPrice(ticker.toUpperCase());
    return json(200, { ticker: ticker.toUpperCase(), price });
  } catch (err) {
    return json(err.statusCode || 502, { error: err.message });
  }
}

async function handleGetSnapshot(ctx, tradeId) {
  const order = await getOrder(ctx.accountId, tradeId);
  if (!order) return json(404, { error: "Order not found" });
  if (!["SUBMITTED", "FILLED"].includes(order.status))
    return json(409, { error: "Snapshot only available for SUBMITTED or FILLED orders" });
  try {
    const snapshot = await buildSnapshot(order);
    return json(200, { tradeId, snapshot });
  } catch (err) {
    return json(err.statusCode || 502, { error: err.message });
  }
}

async function handleCheckFill(ctx, tradeId) {
  const order = await getOrder(ctx.accountId, tradeId);
  if (!order)                        return json(404, { error: "Order not found" });
  if (order.status !== "SUBMITTED")  return json(409, { error: `Order is in status ${order.status} — only SUBMITTED orders can be checked` });

  try {
    const result = await evaluateFill(order);

    if (result.expired) {
      await updateOrder(ctx.accountId, tradeId, {
        status:             "EXPIRED",
        modeStatus:         `${TRADE_MODE}#EXPIRED`,
        expiredAt:          new Date().toISOString(),
        expiredResult:      result.expiredResult,
        stockPriceAtExpiry: result.stockPrice,
      });
      log("INFO", "order_expired", { accountId: ctx.accountId, tradeId, expiredResult: result.expiredResult });
      return json(200, { tradeId, status: "EXPIRED", expiredResult: result.expiredResult, stockPrice: result.stockPrice });
    }

    if (result.shouldFill) {
      await updateOrder(ctx.accountId, tradeId, {
        status:       "FILLED",
        modeStatus:   `${TRADE_MODE}#FILLED`,
        fillPrice:    result.fillPrice,
        filledAt:     new Date().toISOString(),
        fillSnapshot: result.snapshot,
      });
      log("INFO", "order_filled", { accountId: ctx.accountId, tradeId, fillPrice: result.fillPrice });
      return json(200, { tradeId, status: "FILLED", fillPrice: result.fillPrice, snapshot: result.snapshot });
    }

    await updateOrder(ctx.accountId, tradeId, { lastSnapshot: result.snapshot });
    return json(200, {
      tradeId, status: "SUBMITTED", filled: false,
      currentPrice: result.snapshot.marketPrice,
      limitPrice:   order.limitPrice,
      snapshot:     result.snapshot,
    });

  } catch (err) {
    log("ERROR", "check_fill_failed", { accountId: ctx.accountId, tradeId, error: err.message });
    return json(err.statusCode || 502, { error: err.message, tradeId });
  }
}

// ── Auto-fill scheduler (EventBridge every 15 min) ───────────────────────────
async function handleAutoFill() {
  log("INFO", "auto_fill_start", {});
  const orders = await listAllSubmittedOrders();
  log("INFO", "auto_fill_found", { count: orders.length });

  let filled = 0, expired = 0, errors = 0;

  await Promise.allSettled(orders.map(async (order) => {
    try {
      const result = await evaluateFill(order);

      if (result.expired) {
        await updateOrder(order.accountId, order.tradeId, {
          status:             "EXPIRED",
          modeStatus:         `${TRADE_MODE}#EXPIRED`,
          expiredAt:          new Date().toISOString(),
          expiredResult:      result.expiredResult,
          stockPriceAtExpiry: result.stockPrice,
        });
        expired++;
        log("INFO", "auto_fill_expired", { tradeId: order.tradeId, result: result.expiredResult });
        return;
      }

      if (result.shouldFill) {
        await updateOrder(order.accountId, order.tradeId, {
          status:       "FILLED",
          modeStatus:   `${TRADE_MODE}#FILLED`,
          fillPrice:    result.fillPrice,
          filledAt:     new Date().toISOString(),
          fillSnapshot: result.snapshot,
          autoFilled:   true,
        });
        filled++;
        log("INFO", "auto_fill_filled", { tradeId: order.tradeId, fillPrice: result.fillPrice });
      }
    } catch (err) {
      errors++;
      log("ERROR", "auto_fill_order_error", { tradeId: order.tradeId, error: err.message });
    }
  }));

  log("INFO", "auto_fill_complete", { filled, expired, errors, total: orders.length });
  return { filled, expired, errors, total: orders.length };
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // EventBridge scheduled trigger
  if (event.source === "aws.events") return handleAutoFill();

  const method  = (event.requestContext?.http?.method || "GET").toUpperCase();
  const rawPath = event.rawPath || event.path || "/";

  if (method === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };

  let body = null;
  if (event.body) {
    try {
      body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body);
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }
  }

  const pathParts      = rawPath.split("/").filter(Boolean);
  const lastSegment    = pathParts[pathParts.length - 1];
  const tradeIdFromPath = /^PAPER_/.test(lastSegment) ? lastSegment : null;

  log("INFO", "request_received", { method, rawPath, tradeIdFromPath });

  try {
    const ctx = await resolveContext(event);
    assertRead(ctx, "paperTrading");

    if (method === "GET"    && rawPath.endsWith("/paper-trade/staged"))
      return handleListStaged(ctx);

    if (method === "POST"   && rawPath.endsWith("/paper-trade/staged"))
      { assertWrite(ctx, "paperTrading"); return handleStageOrder(ctx, body); }

    if (method === "DELETE" && tradeIdFromPath && rawPath.includes("/paper-trade/staged/"))
      { assertWrite(ctx, "paperTrading"); return handleDiscardStaged(ctx, tradeIdFromPath); }

    if (method === "PATCH"  && tradeIdFromPath && rawPath.includes("/paper-trade/staged/"))
      { assertWrite(ctx, "paperTrading"); return handleUpdateLimitPrice(ctx, tradeIdFromPath, body); }

    if (method === "POST"   && tradeIdFromPath && rawPath.includes("/paper-trade/submit/"))
      { assertWrite(ctx, "paperTrading"); return handleSubmitOrder(ctx, tradeIdFromPath); }

    if (method === "GET"    && rawPath.endsWith("/paper-trade/orders"))
      return handleListOrders(ctx);

    if (method === "POST"   && tradeIdFromPath && rawPath.includes("/paper-trade/status/"))
      return handleCheckFill(ctx, tradeIdFromPath);

    if (method === "GET"    && rawPath.includes("/paper-trade/quote/"))
      return handleGetQuote(ctx, lastSegment);

    if (method === "GET"    && tradeIdFromPath && rawPath.includes("/paper-trade/snapshot/"))
      return handleGetSnapshot(ctx, tradeIdFromPath);

    if (method === "POST"   && tradeIdFromPath && rawPath.includes("/paper-trade/close/"))
      { assertWrite(ctx, "paperTrading"); return handleClosePosition(ctx, tradeIdFromPath, body); }

    return json(404, { error: "Route not found" });

  } catch (err) {
    if (err.statusCode === 401) return json(401, { error: "Unauthorized" });
    if (err.statusCode === 403) return json(403, { error: err.message });
    log("ERROR", "unhandled_error", { error: err.message, stack: err.stack });
    return json(500, { error: "Internal server error" });
  }
};
