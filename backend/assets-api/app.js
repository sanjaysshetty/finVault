const crypto = require("crypto");

const { json, badRequest, notFound } = require("finvault-shared/http");
const { putItem, getItem, deleteItem, queryByGSI1 } = require("finvault-shared/ddb");
const { addMonths, computeValue } = require("finvault-shared/financeMath");

/* ---------------- helpers ---------------- */

function getUserIdFromJwt(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  const sub = claims?.sub;
  if (!sub) throw new Error("Unauthorized");
  return sub;
}

function getMethod(event) {
  return event?.requestContext?.http?.method || event?.httpMethod || "GET";
}

function getPath(event) {
  return event?.rawPath || event?.requestContext?.http?.path || event?.path || "/";
}

function parseBody(event) {
  if (!event?.body) return null;
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
}

function pickId(prefix) {
  return `${prefix}-${crypto.randomBytes(10).toString("hex")}`;
}

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === "";
}

function toISODateOrBlank(v) {
  if (isBlank(v)) return "";
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error("date must be YYYY-MM-DD");
  return s;
}

function toNumOrBlank(v) {
  if (isBlank(v)) return "";
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error("must be a number");
  return n;
}

function toUpperTrim(v) {
  return String(v || "").toUpperCase().trim();
}

/* =========================================================
   FIXED INCOME (unchanged)
========================================================= */

const FIXED_BASE = "/assets/fixedincome";

function validateFixedIncome(body) {
  const name = String(body.name || "").trim();
  if (!name) throw new Error("name is required");

  const principal = Number(body.principal);
  if (!Number.isFinite(principal) || principal <= 0) throw new Error("principal must be > 0");

  const annualRate = Number(body.annualRate);
  if (!Number.isFinite(annualRate) || annualRate < 0) throw new Error("annualRate must be >= 0");

  const startDate = String(body.startDate || "").slice(0, 10);
  if (!startDate) throw new Error("startDate is required (YYYY-MM-DD)");

  const termMonths = parseInt(body.termMonths, 10);
  if (!Number.isFinite(termMonths) || termMonths <= 0) throw new Error("termMonths must be > 0");

  const interestType = String(body.interestType || "SIMPLE").toUpperCase();
  if (!["SIMPLE", "COMPOUND"].includes(interestType))
    throw new Error("interestType must be SIMPLE or COMPOUND");

  const compoundFrequency = String(body.compoundFrequency || "YEARLY").toUpperCase();
  if (!["DAILY", "MONTHLY", "QUARTERLY", "YEARLY"].includes(compoundFrequency))
    throw new Error("compoundFrequency must be DAILY, MONTHLY, QUARTERLY, or YEARLY");

  const notes = String(body.notes || "").trim();

  const maturityDate = addMonths(startDate, termMonths);
  const maturityCalc = computeValue({
    principal,
    annualRate,
    startDate,
    asOfDate: maturityDate,
    interestType,
    compoundFrequency,
  });

  return {
    name,
    principal: Number(principal.toFixed(2)),
    annualRate: Number(annualRate.toFixed(8)),
    startDate,
    termMonths,
    interestType,
    compoundFrequency,
    notes,
    maturityDate,
    maturityAmount: Number(maturityCalc.value.toFixed(2)),
  };
}

async function fixedList(event) {
  const userId = getUserIdFromJwt(event);
  const items = await queryByGSI1(userId, "FIXEDINCOME#");
  return json(200, items);
}

async function fixedCreate(event) {
  const userId = getUserIdFromJwt(event);
  const body = parseBody(event);
  if (!body) return badRequest("Invalid JSON body");

  let asset;
  try {
    asset = validateFixedIncome(body);
  } catch (e) {
    return badRequest(e.message);
  }

  const assetId = body.assetId || pickId("fix");
  const now = new Date().toISOString();

  const curr = computeValue({
    principal: asset.principal,
    annualRate: asset.annualRate,
    startDate: asset.startDate,
    asOfDate: new Date().toISOString().slice(0, 10),
    interestType: asset.interestType,
    compoundFrequency: asset.compoundFrequency,
  });

  const item = {
    userId,
    assetId,
    assetType: "FIXEDINCOME",
    ...asset,
    currentValue: Number(curr.value.toFixed(2)),
    interestEarnedToDate: Number(curr.interest.toFixed(2)),
    gsi1pk: userId,
    gsi1sk: `FIXEDINCOME#${asset.startDate}#${assetId}`,
    createdAt: now,
    updatedAt: now,
  };

  await putItem(item);
  return json(201, item);
}

async function fixedGet(event, assetId) {
  const userId = getUserIdFromJwt(event);
  const item = await getItem(userId, assetId);
  if (!item || item.assetType !== "FIXEDINCOME") return notFound();
  return json(200, item);
}

async function fixedUpdate(event, assetId) {
  const userId = getUserIdFromJwt(event);
  const patch = parseBody(event);
  if (!patch) return badRequest("Invalid JSON body");

  const existing = await getItem(userId, assetId);
  if (!existing || existing.assetType !== "FIXEDINCOME") return notFound();

  let merged;
  try {
    merged = validateFixedIncome({ ...existing, ...patch });
  } catch (e) {
    return badRequest(e.message);
  }

  const now = new Date().toISOString();

  const curr = computeValue({
    principal: merged.principal,
    annualRate: merged.annualRate,
    startDate: merged.startDate,
    asOfDate: new Date().toISOString().slice(0, 10),
    interestType: merged.interestType,
    compoundFrequency: merged.compoundFrequency,
  });

  const item = {
    ...existing,
    ...merged,
    userId,
    assetId,
    assetType: "FIXEDINCOME",
    currentValue: Number(curr.value.toFixed(2)),
    interestEarnedToDate: Number(curr.interest.toFixed(2)),
    gsi1pk: userId,
    gsi1sk: `FIXEDINCOME#${merged.startDate}#${assetId}`,
    updatedAt: now,
  };

  await putItem(item);
  return json(200, item);
}

async function fixedDelete(event, assetId) {
  const userId = getUserIdFromJwt(event);
  const existing = await getItem(userId, assetId);
  if (!existing || existing.assetType !== "FIXEDINCOME") return notFound();

  await deleteItem(userId, assetId);
  return json(204, null);
}

/* =========================================================
   BULLION TRANSACTIONS (unchanged)
========================================================= */

const BULL_TX_BASE = "/assets/bullion/transactions";

function validateBullionTx(body) {
  const type = String(body.type || "").toUpperCase();
  const metal = String(body.metal || "").toUpperCase();
  const date = String(body.date || "").slice(0, 10);

  if (!["BUY", "SELL"].includes(type)) throw new Error("type must be BUY or SELL");
  if (!["GOLD", "SILVER"].includes(metal)) throw new Error("metal must be GOLD or SILVER");
  if (!date) throw new Error("date is required (YYYY-MM-DD)");

  const quantityOz = Number(body.quantityOz);
  const unitPrice = Number(body.unitPrice);
  const fees = body.fees === undefined || body.fees === "" ? 0 : Number(body.fees);

  if (!Number.isFinite(quantityOz) || quantityOz <= 0) throw new Error("quantityOz must be > 0");
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) throw new Error("unitPrice must be > 0");
  if (!Number.isFinite(fees) || fees < 0) throw new Error("fees must be >= 0");

  return {
    type,
    metal,
    date,
    quantityOz: Number(quantityOz.toFixed(2)),
    unitPrice: Number(unitPrice.toFixed(2)),
    fees: Number(fees.toFixed(2)),
    notes: String(body.notes || "").trim(),
  };
}

async function bullList(event) {
  const userId = getUserIdFromJwt(event);
  const items = await queryByGSI1(userId, "BULLION_TX#");
  return json(200, items);
}

async function bullCreate(event) {
  const userId = getUserIdFromJwt(event);
  const body = parseBody(event);
  if (!body) return badRequest("Invalid JSON body");

  let tx;
  try {
    tx = validateBullionTx(body);
  } catch (e) {
    return badRequest(e.message);
  }

  const txId = body.txId || body.assetId || pickId("btx");
  const now = new Date().toISOString();

  const item = {
    userId,
    assetId: txId,
    txId,
    assetType: "BULLION_TX",
    ...tx,
    gsi1pk: userId,
    gsi1sk: `BULLION_TX#${tx.date}#${txId}`,
    createdAt: now,
    updatedAt: now,
  };

  await putItem(item);
  return json(201, item);
}

async function bullUpdate(event, txId) {
  const userId = getUserIdFromJwt(event);
  const patch = parseBody(event);
  if (!patch) return badRequest("Invalid JSON body");

  const existing = await getItem(userId, txId);
  if (!existing || existing.assetType !== "BULLION_TX") return notFound();

  let merged;
  try {
    merged = validateBullionTx({ ...existing, ...patch });
  } catch (e) {
    return badRequest(e.message);
  }

  const now = new Date().toISOString();
  const item = {
    ...existing,
    ...merged,
    userId,
    assetId: txId,
    txId,
    gsi1pk: userId,
    gsi1sk: `BULLION_TX#${merged.date}#${txId}`,
    updatedAt: now,
  };

  await putItem(item);
  return json(200, item);
}

async function bullDelete(event, txId) {
  const userId = getUserIdFromJwt(event);
  const existing = await getItem(userId, txId);
  if (!existing || existing.assetType !== "BULLION_TX") return notFound();

  await deleteItem(userId, txId);
  return json(204, null);
}

/* =========================================================
   STOCK TRANSACTIONS (unchanged)
========================================================= */

const STOCK_TX_BASE = "/assets/stocks/transactions";

function validateStockTx(body) {
  const type = String(body.type || "").toUpperCase();
  const symbol = String(body.symbol || "").toUpperCase().trim();
  const date = String(body.date || "").slice(0, 10);

  if (!["BUY", "SELL"].includes(type)) throw new Error("type must be BUY or SELL");
  if (!symbol) throw new Error("symbol is required (e.g., AAPL)");
  if (!date) throw new Error("date is required (YYYY-MM-DD)");

  const shares = Number(body.shares);
  const price = Number(body.price);
  const fees = body.fees === undefined || body.fees === "" ? 0 : Number(body.fees);

  if (!Number.isFinite(shares) || shares <= 0) throw new Error("shares must be > 0");
  if (!Number.isFinite(price) || price <= 0) throw new Error("price must be > 0");
  if (!Number.isFinite(fees) || fees < 0) throw new Error("fees must be >= 0");

  return {
    type,
    symbol,
    date,
    shares: Number(shares.toFixed(4)),
    price: Number(price.toFixed(4)),
    fees: Number(fees.toFixed(2)),
    notes: String(body.notes || "").trim(),
  };
}

async function stockList(event) {
  const userId = getUserIdFromJwt(event);
  const items = await queryByGSI1(userId, "STOCK_TX#");
  return json(200, items);
}

async function stockCreate(event) {
  const userId = getUserIdFromJwt(event);
  const body = parseBody(event);
  if (!body) return badRequest("Invalid JSON body");

  let tx;
  try {
    tx = validateStockTx(body);
  } catch (e) {
    return badRequest(e.message);
  }

  const txId = body.txId || body.assetId || pickId("stx");
  const now = new Date().toISOString();

  const item = {
    userId,
    assetId: txId,
    txId,
    assetType: "STOCK_TX",
    ...tx,
    gsi1pk: userId,
    gsi1sk: `STOCK_TX#${tx.date}#${txId}`,
    createdAt: now,
    updatedAt: now,
  };

  await putItem(item);
  return json(201, item);
}

async function stockUpdate(event, txId) {
  const userId = getUserIdFromJwt(event);
  const patch = parseBody(event);
  if (!patch) return badRequest("Invalid JSON body");

  const existing = await getItem(userId, txId);
  if (!existing || existing.assetType !== "STOCK_TX") return notFound();

  let merged;
  try {
    merged = validateStockTx({ ...existing, ...patch });
  } catch (e) {
    return badRequest(e.message);
  }

  const now = new Date().toISOString();
  const item = {
    ...existing,
    ...merged,
    userId,
    assetId: txId,
    txId,
    gsi1pk: userId,
    gsi1sk: `STOCK_TX#${merged.date}#${txId}`,
    updatedAt: now,
  };

  await putItem(item);
  return json(200, item);
}

async function stockDelete(event, txId) {
  const userId = getUserIdFromJwt(event);
  const existing = await getItem(userId, txId);
  if (!existing || existing.assetType !== "STOCK_TX") return notFound();

  await deleteItem(userId, txId);
  return json(204, null);
}

/* =========================================================
   CRYPTO TRANSACTIONS (unchanged)
========================================================= */

const CRYPTO_TX_BASE = "/assets/crypto/transactions";

function validateCryptoTx(body) {
  const type = String(body.type || "").toUpperCase();
  const symbol = String(body.symbol || "").toUpperCase().trim();
  const date = String(body.date || "").slice(0, 10);

  if (!["BUY", "SELL"].includes(type)) throw new Error("type must be BUY or SELL");
  if (!symbol) throw new Error("symbol is required (e.g., BTC-USD)");
  if (!date) throw new Error("date is required (YYYY-MM-DD)");

  const quantity = Number(body.quantity);
  const unitPrice = Number(body.unitPrice);
  const fees = body.fees === undefined || body.fees === "" ? 0 : Number(body.fees);

  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("quantity must be > 0");
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) throw new Error("unitPrice must be > 0");
  if (!Number.isFinite(fees) || fees < 0) throw new Error("fees must be >= 0");

  return {
    type,
    symbol,
    date,
    quantity: Number(quantity.toFixed(8)),
    unitPrice: Number(unitPrice.toFixed(2)),
    fees: Number(fees.toFixed(2)),
    notes: String(body.notes || "").trim(),
  };
}

async function cryptoList(event) {
  const userId = getUserIdFromJwt(event);
  const items = await queryByGSI1(userId, "CRYPTO_TX#");
  return json(200, items);
}

async function cryptoCreate(event) {
  const userId = getUserIdFromJwt(event);
  const body = parseBody(event);
  if (!body) return badRequest("Invalid JSON body");

  let tx;
  try {
    tx = validateCryptoTx(body);
  } catch (e) {
    return badRequest(e.message);
  }

  const txId = body.txId || body.assetId || pickId("ctx");
  const now = new Date().toISOString();

  const item = {
    userId,
    assetId: txId,
    txId,
    assetType: "CRYPTO_TX",
    ...tx,
    gsi1pk: userId,
    gsi1sk: `CRYPTO_TX#${tx.date}#${txId}`,
    createdAt: now,
    updatedAt: now,
  };

  await putItem(item);
  return json(201, item);
}

async function cryptoUpdate(event, txId) {
  const userId = getUserIdFromJwt(event);
  const patch = parseBody(event);
  if (!patch) return badRequest("Invalid JSON body");

  const existing = await getItem(userId, txId);
  if (!existing || existing.assetType !== "CRYPTO_TX") return notFound();

  let merged;
  try {
    merged = validateCryptoTx({ ...existing, ...patch });
  } catch (e) {
    return badRequest(e.message);
  }

  const now = new Date().toISOString();
  const item = {
    ...existing,
    ...merged,
    userId,
    assetId: txId,
    txId,
    gsi1pk: userId,
    gsi1sk: `CRYPTO_TX#${merged.date}#${txId}`,
    updatedAt: now,
  };

  await putItem(item);
  return json(200, item);
}

async function cryptoDelete(event, txId) {
  const userId = getUserIdFromJwt(event);
  const existing = await getItem(userId, txId);
  if (!existing || existing.assetType !== "CRYPTO_TX") return notFound();

  await deleteItem(userId, txId);
  return json(204, null);
}

/* =========================================================
   ✅ OPTIONS TRANSACTIONS (EXCEL SHAPE) (unchanged)
========================================================= */

const OPTIONS_TX_BASE = "/assets/options/transactions";

function validateOptionsTx(body) {
  const type = toUpperTrim(body.type);
  const allowedTypes = ["SELL", "BUY", "ASS", "ASSIGNED", "SDI"];
  if (!allowedTypes.includes(type))
    throw new Error(`type must be one of: ${allowedTypes.join(", ")}`);

  const openDate = toISODateOrBlank(body.openDate || body.open);
  if (!openDate) throw new Error("openDate is required (YYYY-MM-DD)");

  const expiry = toISODateOrBlank(body.expiry || body.expiration || "");
  const closeDate = toISODateOrBlank(body.closeDate || body.close || "");

  const ticker = toUpperTrim(body.ticker);
  if (!ticker) throw new Error("ticker is required (e.g., SPY)");

  const event = String(body.event || "").trim();
  const strikes = String(body.strikes || body.ks || "").trim();

  const qty = toNumOrBlank(body.qty);
  if (qty === "" || qty <= 0) throw new Error("qty must be a positive number");

  const fill = toNumOrBlank(body.fill);
  if (fill === "" || fill <= 0) throw new Error("fill must be a positive number");

  const closePrice = toNumOrBlank(body.closePrice ?? body.close$ ?? body.closeDollar);
  if (closePrice !== "" && closePrice < 0) throw new Error("closePrice must be >= 0");

  const fee = toNumOrBlank(body.fee);
  if (fee !== "" && fee < 0) throw new Error("fee must be >= 0");

  const coll = toNumOrBlank(body.coll);
  if (coll !== "" && coll < 0) throw new Error("coll must be >= 0");

  const rollOver = String(
    body.rollOver ?? body.rollover ?? body.roll_over ?? body["Roll Over"] ?? ""
  ).trim();

  const notes = String(body.notes || "").trim();

  return {
    type,
    openDate,
    expiry,
    closeDate,
    ticker,
    event,
    strikes,
    qty: Number(qty),
    fill: Number(fill),
    closePrice: closePrice === "" ? "" : Number(closePrice),
    fee: fee === "" ? "" : Number(fee),
    coll: coll === "" ? "" : Number(coll),
    rollOver,
    notes,
  };
}

async function optionsList(event) {
  const userId = getUserIdFromJwt(event);
  const items = await queryByGSI1(userId, "OPTIONS_TX#");
  return json(200, items);
}

async function optionsCreate(event) {
  const userId = getUserIdFromJwt(event);
  const body = parseBody(event);
  if (!body) return badRequest("Invalid JSON body");

  let tx;
  try {
    tx = validateOptionsTx(body);
  } catch (e) {
    return badRequest(e.message);
  }

  const txId = body.txId || body.assetId || pickId("otx");
  const now = new Date().toISOString();

  const item = {
    userId,
    assetId: txId,
    txId,
    assetType: "OPTIONS_TX",
    ...tx,
    gsi1pk: userId,
    gsi1sk: `OPTIONS_TX#${tx.openDate}#${txId}`,
    createdAt: now,
    updatedAt: now,
  };

  await putItem(item);
  return json(201, item);
}

async function optionsUpdate(event, txId) {
  const userId = getUserIdFromJwt(event);
  const patch = parseBody(event);
  if (!patch) return badRequest("Invalid JSON body");

  const existing = await getItem(userId, txId);
  if (!existing || existing.assetType !== "OPTIONS_TX") return notFound();

  let merged;
  try {
    merged = validateOptionsTx({ ...existing, ...patch });
  } catch (e) {
    return badRequest(e.message);
  }

  const now = new Date().toISOString();
  const item = {
    ...existing,
    ...merged,
    userId,
    assetId: txId,
    txId,
    gsi1pk: userId,
    gsi1sk: `OPTIONS_TX#${merged.openDate}#${txId}`,
    updatedAt: now,
  };

  await putItem(item);
  return json(200, item);
}

async function optionsDelete(event, txId) {
  const userId = getUserIdFromJwt(event);
  const existing = await getItem(userId, txId);
  if (!existing || existing.assetType !== "OPTIONS_TX") return notFound();

  await deleteItem(userId, txId);
  return json(204, null);
}

/* =========================================================
   ✅ NAV “MANUAL ASSET BUCKETS”
   assetTypes:
   - RETIRE_TX
   - EDUCATION_TX
   - OTHERPROP_TX
   Routes:
   - /assets/retirement/transactions (GET, POST)
   - /assets/retirement/transactions/{txId} (PATCH, DELETE)
   - /assets/education/transactions ...
   - /assets/property/transactions ...
========================================================= */

function validateNavBucketTx(body) {
  const date = toISODateOrBlank(body.date);
  if (!date) throw new Error("date is required (YYYY-MM-DD)");

  const name = String(body.name || "").trim();
  if (!name) throw new Error("name is required");

  const amount = toNumOrBlank(body.amount);
  if (amount === "" || amount < 0) throw new Error("amount must be a number >= 0");

  const notes = String(body.notes || "").trim();

  return {
    date,
    name,
    amount: Number(Number(amount).toFixed(2)),
    notes,
  };
}

function makeNavBucketHandlers({ assetType, idPrefix }) {
  const prefixForQuery = `${assetType}#`;

  return {
    async list(event) {
      const userId = getUserIdFromJwt(event);
      const items = await queryByGSI1(userId, prefixForQuery);
      return json(200, items);
    },

    async create(event) {
      const userId = getUserIdFromJwt(event);
      const body = parseBody(event);
      if (!body) return badRequest("Invalid JSON body");

      let tx;
      try {
        tx = validateNavBucketTx(body);
      } catch (e) {
        return badRequest(e.message);
      }

      const txId = body.txId || body.assetId || pickId(idPrefix);
      const now = new Date().toISOString();

      const item = {
        userId,
        assetId: txId,
        txId,
        assetType,
        ...tx,
        gsi1pk: userId,
        gsi1sk: `${assetType}#${tx.date}#${txId}`,
        createdAt: now,
        updatedAt: now,
      };

      await putItem(item);
      return json(201, item);
    },

    async update(event, txId) {
      const userId = getUserIdFromJwt(event);
      const patch = parseBody(event);
      if (!patch) return badRequest("Invalid JSON body");

      const existing = await getItem(userId, txId);
      if (!existing || existing.assetType !== assetType) return notFound();

      let merged;
      try {
        merged = validateNavBucketTx({ ...existing, ...patch });
      } catch (e) {
        return badRequest(e.message);
      }

      const now = new Date().toISOString();

      const item = {
        ...existing,
        ...merged,
        userId,
        assetId: txId,
        txId,
        gsi1pk: userId,
        gsi1sk: `${assetType}#${merged.date}#${txId}`,
        updatedAt: now,
      };

      await putItem(item);
      return json(200, item);
    },

    async del(event, txId) {
      const userId = getUserIdFromJwt(event);
      const existing = await getItem(userId, txId);
      if (!existing || existing.assetType !== assetType) return notFound();

      await deleteItem(userId, txId);
      return json(204, null);
    },
  };
}

const RETIRE_TX_BASE = "/assets/retirement/transactions";
const EDUCATION_TX_BASE = "/assets/education/transactions";
const OTHERPROP_TX_BASE = "/assets/property/transactions";

const retireHandlers = makeNavBucketHandlers({ assetType: "RETIRE_TX", idPrefix: "rtx" });
const eduHandlers = makeNavBucketHandlers({ assetType: "EDUCATION_TX", idPrefix: "etx" });
const propHandlers = makeNavBucketHandlers({ assetType: "OTHERPROP_TX", idPrefix: "ptx" });

/* =========================================================
   NAV STATE (sections + rows persisted)
========================================================= */

const NAV_BASE = "/nav";
const NAV_ASSET_ID = "nav-state";
const NAV_ASSET_TYPE = "NAV_STATE";

function validateNavState(body) {
  if (!body || typeof body !== "object") throw new Error("Invalid JSON body");

  const required = ["usaAssets", "usaLiabs", "indiaAssets", "indiaLiabs"];
  for (const k of required) {
    if (!Array.isArray(body[k])) throw new Error(`${k} must be an array`);
  }

  // light validation for items
  function validateArr(arr, name) {
    for (const it of arr) {
      if (!it || typeof it !== "object") throw new Error(`${name} contains invalid item`);
      if (it.kind !== "section" && it.kind !== "row") throw new Error(`${name} item.kind must be section|row`);
      if (!it.id) throw new Error(`${name} item.id required`);
      if (it.kind === "section") {
        if (typeof it.label !== "string") throw new Error(`${name} section.label must be string`);
      } else {
        if (typeof it.label !== "string") throw new Error(`${name} row.label must be string`);
        // amount can be number or string (frontend uses string input)
        if (it.amount !== undefined && typeof it.amount !== "number" && typeof it.amount !== "string")
          throw new Error(`${name} row.amount must be number|string`);
        if (it.remarks !== undefined && typeof it.remarks !== "string")
          throw new Error(`${name} row.remarks must be string`);
        if (it.source !== undefined && typeof it.source !== "string")
          throw new Error(`${name} row.source must be string`);
      }
    }
  }

  validateArr(body.usaAssets, "usaAssets");
  validateArr(body.usaLiabs, "usaLiabs");
  validateArr(body.indiaAssets, "indiaAssets");
  validateArr(body.indiaLiabs, "indiaLiabs");

  return body;
}

async function navGet(event) {
  const userId = getUserIdFromJwt(event);
  const item = await getItem(userId, NAV_ASSET_ID);
  if (!item || item.assetType !== NAV_ASSET_TYPE) return json(200, null);
  return json(200, item.state || null);
}

async function navPut(event) {
  const userId = getUserIdFromJwt(event);
  const body = parseBody(event);
  if (!body) return badRequest("Invalid JSON body");

  let state;
  try {
    state = validateNavState(body);
  } catch (e) {
    return badRequest(e.message);
  }

  const now = new Date().toISOString();

  const item = {
    userId,
    assetId: NAV_ASSET_ID,
    assetType: NAV_ASSET_TYPE,
    state,
    gsi1pk: userId,
    gsi1sk: `NAV_STATE#${NAV_ASSET_ID}`,
    createdAt: now,
    updatedAt: now,
  };

  // preserve createdAt if exists
  const existing = await getItem(userId, NAV_ASSET_ID);
  if (existing?.createdAt) item.createdAt = existing.createdAt;

  await putItem(item);
  return json(200, { ok: true });
}

async function navDelete(event) {
  const userId = getUserIdFromJwt(event);
  const existing = await getItem(userId, NAV_ASSET_ID);
  if (!existing || existing.assetType !== NAV_ASSET_TYPE) return json(204, null);
  await deleteItem(userId, NAV_ASSET_ID);
  return json(204, null);
}


/* ---------------- main router ---------------- */

module.exports.handler = async (event) => {
  try {
    const method = getMethod(event).toUpperCase();
    const path = getPath(event);

    if (method === "OPTIONS") return json(204, null);

    // FixedIncome
    if (path === FIXED_BASE) {
      if (method === "GET") return fixedList(event);
      if (method === "POST") return fixedCreate(event);
      return badRequest(`Unsupported method ${method} for ${FIXED_BASE}`);
    }
    if (path.startsWith(`${FIXED_BASE}/`)) {
      const assetId = decodeURIComponent(path.slice(`${FIXED_BASE}/`.length)).trim();
      if (!assetId) return badRequest("assetId is required");
      if (method === "GET") return fixedGet(event, assetId);
      if (method === "PATCH") return fixedUpdate(event, assetId);
      if (method === "DELETE") return fixedDelete(event, assetId);
      return badRequest(`Unsupported method ${method} for ${FIXED_BASE}/{assetId}`);
    }

    // Bullion TX
    if (path === BULL_TX_BASE) {
      if (method === "GET") return bullList(event);
      if (method === "POST") return bullCreate(event);
      return badRequest(`Unsupported method ${method} for ${BULL_TX_BASE}`);
    }
    if (path.startsWith(`${BULL_TX_BASE}/`)) {
      const txId = decodeURIComponent(path.slice(`${BULL_TX_BASE}/`.length)).trim();
      if (!txId) return badRequest("txId is required");
      if (method === "PATCH") return bullUpdate(event, txId);
      if (method === "DELETE") return bullDelete(event, txId);
      return badRequest(`Unsupported method ${method} for ${BULL_TX_BASE}/{txId}`);
    }

    // Stock TX
    if (path === STOCK_TX_BASE) {
      if (method === "GET") return stockList(event);
      if (method === "POST") return stockCreate(event);
      return badRequest(`Unsupported method ${method} for ${STOCK_TX_BASE}`);
    }
    if (path.startsWith(`${STOCK_TX_BASE}/`)) {
      const txId = decodeURIComponent(path.slice(`${STOCK_TX_BASE}/`.length)).trim();
      if (!txId) return badRequest("txId is required");
      if (method === "PATCH") return stockUpdate(event, txId);
      if (method === "DELETE") return stockDelete(event, txId);
      return badRequest(`Unsupported method ${method} for ${STOCK_TX_BASE}/{txId}`);
    }

    // Crypto TX
    if (path === CRYPTO_TX_BASE) {
      if (method === "GET") return cryptoList(event);
      if (method === "POST") return cryptoCreate(event);
      return badRequest(`Unsupported method ${method} for ${CRYPTO_TX_BASE}`);
    }
    if (path.startsWith(`${CRYPTO_TX_BASE}/`)) {
      const txId = decodeURIComponent(path.slice(`${CRYPTO_TX_BASE}/`.length)).trim();
      if (!txId) return badRequest("txId is required");
      if (method === "PATCH") return cryptoUpdate(event, txId);
      if (method === "DELETE") return cryptoDelete(event, txId);
      return badRequest(`Unsupported method ${method} for ${CRYPTO_TX_BASE}/{txId}`);
    }

    // Options TX
    if (path === OPTIONS_TX_BASE) {
      if (method === "GET") return optionsList(event);
      if (method === "POST") return optionsCreate(event);
      return badRequest(`Unsupported method ${method} for ${OPTIONS_TX_BASE}`);
    }
    if (path.startsWith(`${OPTIONS_TX_BASE}/`)) {
      const txId = decodeURIComponent(path.slice(`${OPTIONS_TX_BASE}/`.length)).trim();
      if (!txId) return badRequest("txId is required");
      if (method === "PATCH") return optionsUpdate(event, txId);
      if (method === "DELETE") return optionsDelete(event, txId);
      return badRequest(`Unsupported method ${method} for ${OPTIONS_TX_BASE}/{txId}`);
    }

    // ✅ NAV bucket: Retirement
    if (path === RETIRE_TX_BASE) {
      if (method === "GET") return retireHandlers.list(event);
      if (method === "POST") return retireHandlers.create(event);
      return badRequest(`Unsupported method ${method} for ${RETIRE_TX_BASE}`);
    }
    if (path.startsWith(`${RETIRE_TX_BASE}/`)) {
      const txId = decodeURIComponent(path.slice(`${RETIRE_TX_BASE}/`.length)).trim();
      if (!txId) return badRequest("txId is required");
      if (method === "PATCH") return retireHandlers.update(event, txId);
      if (method === "DELETE") return retireHandlers.del(event, txId);
      return badRequest(`Unsupported method ${method} for ${RETIRE_TX_BASE}/{txId}`);
    }

    // ✅ NAV bucket: Education / 529
    if (path === EDUCATION_TX_BASE) {
      if (method === "GET") return eduHandlers.list(event);
      if (method === "POST") return eduHandlers.create(event);
      return badRequest(`Unsupported method ${method} for ${EDUCATION_TX_BASE}`);
    }
    if (path.startsWith(`${EDUCATION_TX_BASE}/`)) {
      const txId = decodeURIComponent(path.slice(`${EDUCATION_TX_BASE}/`.length)).trim();
      if (!txId) return badRequest("txId is required");
      if (method === "PATCH") return eduHandlers.update(event, txId);
      if (method === "DELETE") return eduHandlers.del(event, txId);
      return badRequest(`Unsupported method ${method} for ${EDUCATION_TX_BASE}/{txId}`);
    }

    // ✅ NAV bucket: Property
    if (path === OTHERPROP_TX_BASE) {
      if (method === "GET") return propHandlers.list(event);
      if (method === "POST") return propHandlers.create(event);
      return badRequest(`Unsupported method ${method} for ${OTHERPROP_TX_BASE}`);
    }
    if (path.startsWith(`${OTHERPROP_TX_BASE}/`)) {
      const txId = decodeURIComponent(path.slice(`${OTHERPROP_TX_BASE}/`.length)).trim();
      if (!txId) return badRequest("txId is required");
      if (method === "PATCH") return propHandlers.update(event, txId);
      if (method === "DELETE") return propHandlers.del(event, txId);
      return badRequest(`Unsupported method ${method} for ${OTHERPROP_TX_BASE}/{txId}`);
    }
    // NAV
    if (path === NAV_BASE) {
      if (method === "GET") return navGet(event);
      if (method === "PUT") return navPut(event);
      if (method === "DELETE") return navDelete(event);
      return badRequest(`Unsupported method ${method} for ${NAV_BASE}`);
    }

    return notFound();
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.toLowerCase().includes("unauthorized")) return json(401, { message: "Unauthorized" });
    return json(500, { message: "Internal Server Error", detail: msg });
  }
};
