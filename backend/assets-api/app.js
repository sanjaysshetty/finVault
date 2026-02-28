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
   INSURANCE
========================================================= */

const INSURANCE_BASE = "/assets/insurance";

function validateInsurance(body) {
  const countryRaw = String(body.country || "USA").trim();
  const c = countryRaw.toUpperCase();
  let country;
  if (c === "INDIA" || countryRaw.toLowerCase() === "india" || c === "IN") country = "INDIA";
  else if (c === "USA" || c === "US") country = "USA";
  else throw new Error("country must be USA or India");

  const insuranceType = String(body.insuranceType || "").trim();
  if (!insuranceType) throw new Error("insuranceType is required");

  const provider = String(body.provider || "").trim();
  if (!provider) throw new Error("provider is required");

  const coveredAmount = Number(body.coveredAmount);
  if (!Number.isFinite(coveredAmount) || coveredAmount <= 0) {
    throw new Error("coveredAmount must be a number > 0");
  }

  const remarks = String(body.remarks || "").trim();

  return {
    country,
    insuranceType,
    provider,
    coveredAmount: Number(coveredAmount.toFixed(2)),
    remarks,
  };
}

async function insuranceList(event) {
  const userId = getUserIdFromJwt(event);
  const items = await queryByGSI1(userId, "INSURANCE#");
  return json(200, items);
}

async function insuranceCreate(event) {
  const userId = getUserIdFromJwt(event);
  const body = parseBody(event);
  if (!body) return badRequest("Invalid JSON body");

  let asset;
  try {
    asset = validateInsurance(body);
  } catch (e) {
    return badRequest(e.message);
  }

  const assetId = body.assetId || pickId("ins");
  const now = new Date().toISOString();

  const item = {
    userId,
    assetId,
    assetType: "INSURANCE",
    ...asset,
    gsi1pk: userId,
    gsi1sk: `INSURANCE#${asset.country}#${asset.insuranceType.toUpperCase()}#${assetId}`,
    createdAt: now,
    updatedAt: now,
  };

  await putItem(item);
  return json(201, item);
}

async function insuranceGet(event, assetId) {
  const userId = getUserIdFromJwt(event);
  const item = await getItem(userId, assetId);
  if (!item || item.assetType !== "INSURANCE") return notFound();
  return json(200, item);
}

async function insuranceUpdate(event, assetId) {
  const userId = getUserIdFromJwt(event);
  const patch = parseBody(event);
  if (!patch) return badRequest("Invalid JSON body");

  const existing = await getItem(userId, assetId);
  if (!existing || existing.assetType !== "INSURANCE") return notFound();

  let merged;
  try {
    merged = validateInsurance({ ...existing, ...patch });
  } catch (e) {
    return badRequest(e.message);
  }

  const now = new Date().toISOString();

  const item = {
    ...existing,
    ...merged,
    userId,
    assetId,
    assetType: "INSURANCE",
    gsi1pk: userId,
    gsi1sk: `INSURANCE#${merged.country}#${String(merged.insuranceType).toUpperCase()}#${assetId}`,
    updatedAt: now,
  };

  await putItem(item);
  return json(200, item);
}

async function insuranceDelete(event, assetId) {
  const userId = getUserIdFromJwt(event);
  const existing = await getItem(userId, assetId);
  if (!existing || existing.assetType !== "INSURANCE") return notFound();

  await deleteItem(userId, assetId);
  return json(204, null);
}

/* =========================================================
   NAV STATE (liabilities persisted)
========================================================= */

const NAV_BASE = "/nav";
const NAV_ASSET_ID = "nav-state";
const NAV_ASSET_TYPE = "NAV_STATE";

function validateNavArray(arr, name) {
  if (!Array.isArray(arr)) throw new Error(`${name} must be an array`);
  // light validation to avoid breaking existing saved state
  for (const it of arr) {
    if (!it || typeof it !== "object") throw new Error(`${name} contains invalid item`);
    const kind = String(it.kind || "").toLowerCase();
    if (kind !== "section" && kind !== "row") throw new Error(`${name} item kind must be section or row`);
    if (kind === "section") {
      if (!String(it.label || "").trim()) throw new Error(`${name} section label required`);
    } else {
      if (!String(it.label || "").trim()) throw new Error(`${name} row label required`);
      const amt = Number(it.amount);
      if (!Number.isFinite(amt)) throw new Error(`${name} row amount must be a number`);
    }
  }
  return arr;
}

function validateNavState(body) {
  if (!body || typeof body !== "object") throw new Error("Invalid JSON body");

  const usaLiabs = validateNavArray(body.usaLiabs ?? [], "usaLiabs");
  const indiaLiabs = validateNavArray(body.indiaLiabs ?? [], "indiaLiabs");

  // Allow optional assets arrays for backward compatibility (ignored by new UI)
  const usaAssets = Array.isArray(body.usaAssets) ? body.usaAssets : [];
  const indiaAssets = Array.isArray(body.indiaAssets) ? body.indiaAssets : [];

  return { usaAssets, indiaAssets, usaLiabs, indiaLiabs };
}

async function navGet(event) {
  const userId = getUserIdFromJwt(event);
  const item = await getItem(userId, NAV_ASSET_ID);
  if (!item) return json(200, {});
  return json(200, item.data || {});
}

async function navPut(event) {
  const userId = getUserIdFromJwt(event);
  const body = parseBody(event);
  if (!body) return badRequest("Invalid JSON body");

  let data;
  try {
    data = validateNavState(body);
  } catch (e) {
    return badRequest(e.message);
  }

  const now = new Date().toISOString();

  await putItem({
    userId,
    assetId: NAV_ASSET_ID,
    assetType: NAV_ASSET_TYPE,
    updatedAt: now,
    data,
    // keep a stable GSI1 key so it doesn't mix with other assets lists
    gsi1pk: userId,
    gsi1sk: `NAV#${NAV_ASSET_ID}`,
  });

  return json(200, { ok: true, updatedAt: now });
}

async function navDelete(event) {
  const userId = getUserIdFromJwt(event);
  await deleteItem(userId, NAV_ASSET_ID);
  return json(200, { ok: true });
}

/* =========================================================
   FIXED INCOME (unchanged)
========================================================= */

const FIXED_BASE = "/assets/fixedincome";

function validateFixedIncome(body) {
  const name = String(body.name || "").trim();
  if (!name) throw new Error("name is required");

  const countryRaw = String(body.country || "USA").trim();
  const c = countryRaw.toUpperCase();
  let country;
  if (c === "INDIA" || countryRaw.toLowerCase() === "india" || c === "IN") country = "INDIA";
  else if (c === "USA" || c === "US") country = "USA";
  else throw new Error("country must be USA or India");

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
    country,
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
   OTHER ASSETS (Education/Retirement/Robo/Options/Property)
========================================================= */

const OTHER_ASSETS_BASE = "/assets/otherassets";
const OTHER_ASSET_TYPE = "OTHER_ASSET";
const OTHER_ASSET_CATEGORIES = ["EDUCATION", "RETIREMENT", "ROBO", "CASH", "OPTIONS", "PROPERTY"];

function titleCaseCategory(catUpper) {
  switch (String(catUpper || "").toUpperCase()) {
    case "EDUCATION":
      return "Education";
    case "RETIREMENT":
      return "Retirement";
    case "ROBO":
      return "Robo";
    case "OPTIONS":
      return "Options";
    case "CASH":
      return "Cash";
      case "PROPERTY":
      return "Property";
    default:
      return String(catUpper || "").trim();
  }
}

function validateOtherAsset(body) {
  const catRaw = String(body.category || "").trim();
  const catUpper = catRaw.toUpperCase();
  if (!OTHER_ASSET_CATEGORIES.includes(catUpper)) {
    throw new Error("category must be one of: Education, Retirement, Robo, Cash, Options, Property");
  }

  const description = String(body.description || "").trim();
  if (!description) throw new Error("description is required");

  const value = Number(body.value);
  if (!Number.isFinite(value)) throw new Error("value must be a number");

  const countryRaw = String(body.country || "USA").trim();
  const c = countryRaw.toUpperCase();
  let country;
  if (c === "INDIA" || countryRaw.toLowerCase() === "india" || c === "IN") country = "INDIA";
  else if (c === "USA" || c === "US") country = "USA";
  else throw new Error("country must be USA or India");

  return {
    country,
    category: titleCaseCategory(catUpper),
    categoryKey: catUpper,
    description,
    value: Number(value.toFixed(2)),
  };
}

async function otherAssetsList(event) {
  const userId = getUserIdFromJwt(event);
  const items = await queryByGSI1(userId, "OTHERASSET#");
  return json(200, items);
}

async function otherAssetsCreate(event) {
  const userId = getUserIdFromJwt(event);
  const body = parseBody(event);
  if (!body) return badRequest("Invalid JSON body");

  let asset;
  try {
    asset = validateOtherAsset(body);
  } catch (e) {
    return badRequest(e.message);
  }

  const assetId = body.assetId || pickId("oa");
  const now = new Date().toISOString();
  const d = now.slice(0, 10);

  const item = {
    userId,
    assetId,
    assetType: OTHER_ASSET_TYPE,
    country: asset.country,
    category: asset.category,
    categoryKey: asset.categoryKey,
    description: asset.description,
    value: asset.value,
    gsi1pk: userId,
    gsi1sk: `OTHERASSET#${d}#${asset.categoryKey}#${assetId}`,
    createdAt: now,
    updatedAt: now,
  };

  await putItem(item);
  return json(201, item);
}

async function otherAssetsGet(event, assetId) {
  const userId = getUserIdFromJwt(event);
  const item = await getItem(userId, assetId);
  if (!item || item.assetType !== OTHER_ASSET_TYPE) return notFound();
  return json(200, item);
}

async function otherAssetsUpdate(event, assetId) {
  const userId = getUserIdFromJwt(event);
  const patch = parseBody(event);
  if (!patch) return badRequest("Invalid JSON body");

  const existing = await getItem(userId, assetId);
  if (!existing || existing.assetType !== OTHER_ASSET_TYPE) return notFound();

  let merged;
  try {
    merged = validateOtherAsset({ ...existing, ...patch });
  } catch (e) {
    return badRequest(e.message);
  }

  const now = new Date().toISOString();
  const d = now.slice(0, 10);

  const item = {
    ...existing,
    country: merged.country,
    category: merged.category,
    categoryKey: merged.categoryKey,
    description: merged.description,
    value: merged.value,
    userId,
    assetId,
    assetType: OTHER_ASSET_TYPE,
    gsi1pk: userId,
    gsi1sk: `OTHERASSET#${d}#${merged.categoryKey}#${assetId}`,
    updatedAt: now,
  };

  await putItem(item);
  return json(200, item);
}

async function otherAssetsDelete(event, assetId) {
  const userId = getUserIdFromJwt(event);
  const existing = await getItem(userId, assetId);
  if (!existing || existing.assetType !== OTHER_ASSET_TYPE) return notFound();

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
    unitPrice: Number(unitPrice.toFixed(8)),
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
   FUTURES TRANSACTIONS
   Fields: ticker, contractMonth, type (BUY/SELL), tradeDate,
           qty, price, pointValue, fees, notes
========================================================= */

const FUTURES_TX_BASE = "/assets/futures/transactions";

function validateFuturesTx(body) {
  const type = String(body.type || "").toUpperCase();
  if (!["BUY", "SELL"].includes(type)) throw new Error("type must be BUY or SELL");

  const ticker = String(body.ticker || "").toUpperCase().trim();
  if (!ticker) throw new Error("ticker is required (e.g., ES, NQ, CL)");

  const tradeDate = String(body.tradeDate || "").slice(0, 10);
  if (!tradeDate) throw new Error("tradeDate is required (YYYY-MM-DD)");

  const contractMonth = String(body.contractMonth || "").trim();

  const qty = Number(body.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("qty must be a positive number");

  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("price must be > 0");

  const pointValue = Number(body.pointValue);
  if (!Number.isFinite(pointValue) || pointValue <= 0)
    throw new Error("pointValue must be > 0 (e.g., 50 for ES, 20 for NQ)");

  const fees = body.fees === undefined || body.fees === "" ? 0 : Number(body.fees);
  if (!Number.isFinite(fees) || fees < 0) throw new Error("fees must be >= 0");

  return {
    type,
    ticker,
    contractMonth,
    tradeDate,
    qty: Number(qty.toFixed(4)),
    price: Number(price.toFixed(4)),
    pointValue: Number(pointValue.toFixed(2)),
    fees: Number(fees.toFixed(2)),
    notes: String(body.notes || "").trim(),
  };
}

async function futuresList(event) {
  const userId = getUserIdFromJwt(event);
  const items = await queryByGSI1(userId, "FUTURES_TX#");
  return json(200, items);
}

async function futuresCreate(event) {
  const userId = getUserIdFromJwt(event);
  const body = parseBody(event);
  if (!body) return badRequest("Invalid JSON body");

  let tx;
  try {
    tx = validateFuturesTx(body);
  } catch (e) {
    return badRequest(e.message);
  }

  const txId = body.txId || body.assetId || pickId("ftx");
  const now = new Date().toISOString();

  const item = {
    userId,
    assetId: txId,
    txId,
    assetType: "FUTURES_TX",
    ...tx,
    gsi1pk: userId,
    gsi1sk: `FUTURES_TX#${tx.tradeDate}#${txId}`,
    createdAt: now,
    updatedAt: now,
  };

  await putItem(item);
  return json(201, item);
}

async function futuresUpdate(event, txId) {
  const userId = getUserIdFromJwt(event);
  const patch = parseBody(event);
  if (!patch) return badRequest("Invalid JSON body");

  const existing = await getItem(userId, txId);
  if (!existing || existing.assetType !== "FUTURES_TX") return notFound();

  let merged;
  try {
    merged = validateFuturesTx({ ...existing, ...patch });
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
    gsi1sk: `FUTURES_TX#${merged.tradeDate}#${txId}`,
    updatedAt: now,
  };

  await putItem(item);
  return json(200, item);
}

async function futuresDelete(event, txId) {
  const userId = getUserIdFromJwt(event);
  const existing = await getItem(userId, txId);
  if (!existing || existing.assetType !== "FUTURES_TX") return notFound();

  await deleteItem(userId, txId);
  return json(204, null);
}

/* ---------------- main router ---------------- */

module.exports.handler = async (event) => {
  try {
    const method = getMethod(event).toUpperCase();
    const path = getPath(event);

    if (method === "OPTIONS") return json(204, null);

    
    // NAV state (liabilities)
    if (path === NAV_BASE) {
      if (method === "GET") return navGet(event);
      if (method === "PUT") return navPut(event);
      if (method === "DELETE") return navDelete(event);
      return badRequest(`Unsupported method ${method} for ${NAV_BASE}`);
    }

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

    // Futures TX
    if (path === FUTURES_TX_BASE) {
      if (method === "GET") return futuresList(event);
      if (method === "POST") return futuresCreate(event);
      return badRequest(`Unsupported method ${method} for ${FUTURES_TX_BASE}`);
    }
    if (path.startsWith(`${FUTURES_TX_BASE}/`)) {
      const txId = decodeURIComponent(path.slice(`${FUTURES_TX_BASE}/`.length)).trim();
      if (!txId) return badRequest("txId is required");
      if (method === "PATCH") return futuresUpdate(event, txId);
      if (method === "DELETE") return futuresDelete(event, txId);
      return badRequest(`Unsupported method ${method} for ${FUTURES_TX_BASE}/{txId}`);
    }

    // Insurance
    if (path === INSURANCE_BASE) {
      if (method === "GET") return insuranceList(event);
      if (method === "POST") return insuranceCreate(event);
      return badRequest(`Unsupported method ${method} for ${INSURANCE_BASE}`);
    }
    if (path.startsWith(`${INSURANCE_BASE}/`)) {
      const assetId = decodeURIComponent(path.slice(`${INSURANCE_BASE}/`.length)).trim();
      if (!assetId) return badRequest("assetId is required");
      if (method === "GET") return insuranceGet(event, assetId);
      if (method === "PATCH") return insuranceUpdate(event, assetId);
      if (method === "DELETE") return insuranceDelete(event, assetId);
      return badRequest(`Unsupported method ${method} for ${INSURANCE_BASE}/{assetId}`);
    }
    
// Other Assets
if (path === OTHER_ASSETS_BASE) {
  if (method === "GET") return otherAssetsList(event);
  if (method === "POST") return otherAssetsCreate(event);
  return badRequest(`Unsupported method ${method} for ${OTHER_ASSETS_BASE}`);
}
if (path.startsWith(`${OTHER_ASSETS_BASE}/`)) {
  const assetId = decodeURIComponent(path.slice(`${OTHER_ASSETS_BASE}/`.length)).trim();
  if (!assetId) return badRequest("assetId is required");
  if (method === "GET") return otherAssetsGet(event, assetId);
  if (method === "PATCH") return otherAssetsUpdate(event, assetId);
  if (method === "DELETE") return otherAssetsDelete(event, assetId);
  return badRequest(`Unsupported method ${method} for ${OTHER_ASSETS_BASE}/{assetId}`);
}

    return notFound();
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.toLowerCase().includes("unauthorized")) return json(401, { message: "Unauthorized" });
    return json(500, { message: "Internal Server Error", detail: msg });
  }
};