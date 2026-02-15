const crypto = require("crypto");

const { json, badRequest, notFound } = require("finvault-shared/http");
const { putItem, getItem, deleteItem, queryByGSI1 } = require("finvault-shared/ddb");

/* ---------------- helpers ---------------- */

function getUserIdFromJwt(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  const sub = claims?.sub || claims?.username || claims?.email;
  if (!sub) throw new Error("Unauthorized");
  return String(sub);
}

function parseBody(event) {
  try {
    if (!event?.body) return null;
    return typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch {
    return null;
  }
}

function pickId(prefix) {
  const rnd = crypto.randomBytes(6).toString("hex");
  return `${prefix}_${rnd}`;
}

function normalizeCountry(countryRaw) {
  const raw = String(countryRaw || "USA").trim();
  const c = raw.toUpperCase();
  if (c === "INDIA" || raw.toLowerCase() === "india" || c === "IN") return "INDIA";
  if (c === "USA" || c === "US") return "USA";
  throw new Error("country must be USA or India");
}

function validateLiability(body) {
  const category = String(body.category || "").trim();
  if (!category) throw new Error("category is required");

  const description = String(body.description || "").trim();
  if (!description) throw new Error("description is required");

  const remarks = String(body.remarks || "").trim();

  const value = Number(body.value);
  if (!Number.isFinite(value)) throw new Error("value must be a number");

  const country = normalizeCountry(body.country);

  return {
    country,
    category,
    description,
    remarks,
    value: Number(value.toFixed(2)),
  };
}

/* ---------------- CRUD ---------------- */

const BASE = "/liabilities";
const ASSET_TYPE = "LIABILITY";

async function listLiabilities(event) {
  const userId = getUserIdFromJwt(event);
  // Using GSI pattern consistent with your other modules:
  // gsi1sk starts with LIABILITY#
  const items = await queryByGSI1(userId, "LIABILITY#");
  return json(200, items);
}

async function createLiability(event) {
  const userId = getUserIdFromJwt(event);
  const body = parseBody(event);
  if (!body) return badRequest("Invalid JSON body");

  let liab;
  try {
    liab = validateLiability(body);
  } catch (e) {
    return badRequest(e.message);
  }

  const liabilityId = body.liabilityId || pickId("lb");
  const now = new Date().toISOString();
  const d = now.slice(0, 10);

  const item = {
    userId,
    liabilityId,
    assetId: liabilityId, // ✅ keeps compatibility with existing getItem(userId, assetId) usage
    assetType: ASSET_TYPE,

    country: liab.country,
    category: liab.category,
    description: liab.description,
    remarks: liab.remarks,
    value: liab.value,

    gsi1pk: userId,
    gsi1sk: `LIABILITY#${d}#${liabilityId}`,
    createdAt: now,
    updatedAt: now,
  };

  await putItem(item);
  return json(201, item);
}

async function getLiability(event, liabilityId) {
  const userId = getUserIdFromJwt(event);
  const item = await getItem(userId, liabilityId);
  if (!item || item.assetType !== ASSET_TYPE) return notFound();
  return json(200, item);
}

async function updateLiability(event, liabilityId) {
  const userId = getUserIdFromJwt(event);
  const patch = parseBody(event);
  if (!patch) return badRequest("Invalid JSON body");

  const existing = await getItem(userId, liabilityId);
  if (!existing || existing.assetType !== ASSET_TYPE) return notFound();

  let merged;
  try {
    merged = validateLiability({ ...existing, ...patch });
  } catch (e) {
    return badRequest(e.message);
  }

  const now = new Date().toISOString();
  const d = now.slice(0, 10);

  const item = {
    ...existing,
    userId,
    liabilityId,
    assetId: liabilityId,
    assetType: ASSET_TYPE,

    country: merged.country,
    category: merged.category,
    description: merged.description,
    remarks: merged.remarks,
    value: merged.value,

    gsi1pk: userId,
    gsi1sk: `LIABILITY#${d}#${liabilityId}`,
    updatedAt: now,
  };

  await putItem(item);
  return json(200, item);
}

async function removeLiability(event, liabilityId) {
  const userId = getUserIdFromJwt(event);
  const existing = await getItem(userId, liabilityId);
  if (!existing || existing.assetType !== ASSET_TYPE) return notFound();

  await deleteItem(userId, liabilityId);
  return json(204, null);
}

/* ---------------- router ---------------- */

exports.handler = async (event) => {
  const path = event?.rawPath || event?.path || "";
  const method = String(event?.requestContext?.http?.method || event?.httpMethod || "").toUpperCase();

  if (path === BASE && method === "GET") return listLiabilities(event);
  if (path === BASE && method === "POST") return createLiability(event);

  if (path.startsWith(`${BASE}/`)) {
    const id = decodeURIComponent(path.slice(BASE.length + 1));
    if (method === "GET") return getLiability(event, id);
    if (method === "PATCH") return updateLiability(event, id);
    if (method === "DELETE") return removeLiability(event, id);
  }

  return notFound();
};
