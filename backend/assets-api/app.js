const crypto = require("crypto");

const { json, badRequest, notFound } = require("finvault-shared/http");
const { putItem, getItem, deleteItem, queryByGSI1 } = require("finvault-shared/ddb");
const { addMonths, computeValue } = require("finvault-shared/financeMath");

const ROUTE_BASE = "/assets/fixedincome";

function getUserIdFromJwt(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  const sub = claims?.sub;
  if (!sub) throw new Error("Unauthorized");
  return sub;
}

function parseBody(event) {
  try {
    return JSON.parse(event.body || "{}");
  } catch {
    return null;
  }
}

function getMethod(event) {
  return event.requestContext?.http?.method || event.httpMethod || "GET";
}
function getPath(event) {
  return event.requestContext?.http?.path || event.rawPath || event.path || "";
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function validateAndNormalizeInput(body) {
  const name = String(body.name || "").trim();
  const principal = Number(body.principal);
  const annualRate = Number(body.annualRate); // decimal, e.g. 0.0525
  const startDate = body.startDate;
  const termMonths = Number(body.termMonths);

  if (!name) throw new Error("name is required");
  if (!Number.isFinite(principal) || principal <= 0) throw new Error("principal must be > 0");
  if (!Number.isFinite(annualRate) || annualRate < 0) throw new Error("annualRate must be decimal like 0.0525");
  if (!startDate) throw new Error("startDate is required (YYYY-MM-DD)");
  if (!Number.isFinite(termMonths) || termMonths <= 0) throw new Error("termMonths must be > 0");

  const interestType = String(body.interestType || "SIMPLE").toUpperCase();
  const compoundFrequency = String(body.compoundFrequency || "YEARLY").toUpperCase();
  const notes = String(body.notes || "").trim();

  return { name, principal, annualRate, startDate, termMonths, interestType, compoundFrequency, notes };
}

async function handleCreate(event) {
  const userId = getUserIdFromJwt(event);
  const body = parseBody(event);
  if (!body) return badRequest("Invalid JSON body");

  let input;
  try {
    input = validateAndNormalizeInput(body);
  } catch (e) {
    return badRequest(e.message);
  }

  const assetId = `fi_${crypto.randomUUID()}`;
  const maturityDate = addMonths(input.startDate, input.termMonths);

  const maturityCalc = computeValue({
    principal: input.principal,
    annualRate: input.annualRate,
    startDate: input.startDate,
    asOfDate: maturityDate,
    interestType: input.interestType,
    compoundFrequency: input.compoundFrequency,
  });

  const now = new Date().toISOString();

  const item = {
    userId,
    assetId,
    assetType: "FIXEDINCOME",
    name: input.name,
    principal: Number(input.principal.toFixed(2)),
    annualRate: Number(input.annualRate.toFixed(8)),
    interestType: input.interestType,
    compoundFrequency: input.compoundFrequency,
    startDate: input.startDate,
    termMonths: input.termMonths,
    maturityDate,
    maturityAmount: Number(maturityCalc.value.toFixed(2)),
    notes: input.notes,
    gsi1pk: userId,
    gsi1sk: `FIXEDINCOME#${input.startDate}#${assetId}`,
    createdAt: now,
    updatedAt: now,
  };

  await putItem(item);
  return json(201, item);
}

async function handleList(event) {
  const userId = getUserIdFromJwt(event);
  const asOfDate = todayISO();

  const items = await queryByGSI1(userId, "FIXEDINCOME#");

  const enriched = items.map((it) => {
    const calc = computeValue({
      principal: it.principal,
      annualRate: it.annualRate,
      startDate: it.startDate,
      asOfDate,
      interestType: it.interestType,
      compoundFrequency: it.compoundFrequency,
    });

    return {
      ...it,
      asOfDate,
      currentValue: Number(calc.value.toFixed(2)),
      interestEarnedToDate: Number(calc.interest.toFixed(2)),
    };
  });

  return json(200, enriched);
}

async function handleGet(event, assetId) {
  const userId = getUserIdFromJwt(event);
  const item = await getItem(userId, assetId);
  if (!item || item.assetType !== "FIXEDINCOME") return notFound();

  const asOfDate = todayISO();
  const calc = computeValue({
    principal: item.principal,
    annualRate: item.annualRate,
    startDate: item.startDate,
    asOfDate,
    interestType: item.interestType,
    compoundFrequency: item.compoundFrequency,
  });

  return json(200, {
    ...item,
    asOfDate,
    currentValue: Number(calc.value.toFixed(2)),
    interestEarnedToDate: Number(calc.interest.toFixed(2)),
  });
}

async function handleUpdate(event, assetId) {
  const userId = getUserIdFromJwt(event);
  const patch = parseBody(event);
  if (!patch) return badRequest("Invalid JSON body");

  const existing = await getItem(userId, assetId);
  if (!existing || existing.assetType !== "FIXEDINCOME") return notFound();

  const merged = {
    ...existing,
    name: patch.name !== undefined ? String(patch.name).trim() : existing.name,
    notes: patch.notes !== undefined ? String(patch.notes).trim() : existing.notes,
    principal: patch.principal !== undefined ? Number(patch.principal) : existing.principal,
    annualRate: patch.annualRate !== undefined ? Number(patch.annualRate) : existing.annualRate,
    startDate: patch.startDate !== undefined ? patch.startDate : existing.startDate,
    termMonths: patch.termMonths !== undefined ? Number(patch.termMonths) : existing.termMonths,
    interestType: patch.interestType !== undefined ? String(patch.interestType).toUpperCase() : existing.interestType,
    compoundFrequency:
      patch.compoundFrequency !== undefined ? String(patch.compoundFrequency).toUpperCase() : existing.compoundFrequency,
  };

  try {
    validateAndNormalizeInput(merged);
  } catch (e) {
    return badRequest(e.message);
  }

  const maturityDate = addMonths(merged.startDate, merged.termMonths);
  const maturityCalc = computeValue({
    principal: merged.principal,
    annualRate: merged.annualRate,
    startDate: merged.startDate,
    asOfDate: maturityDate,
    interestType: merged.interestType,
    compoundFrequency: merged.compoundFrequency,
  });

  const now = new Date().toISOString();

  const item = {
    ...merged,
    userId, // ensure correct owner
    maturityDate,
    maturityAmount: Number(maturityCalc.value.toFixed(2)),
    gsi1pk: userId,
    gsi1sk: `FIXEDINCOME#${merged.startDate}#${assetId}`,
    updatedAt: now,
  };

  await putItem(item);
  return json(200, item);
}

async function handleDelete(event, assetId) {
  const userId = getUserIdFromJwt(event);

  const existing = await getItem(userId, assetId);
  if (!existing || existing.assetType !== "FIXEDINCOME") return notFound();

  await deleteItem(userId, assetId);
  return json(204, null);
}

module.exports.handler = async (event) => {
  try {
    const method = getMethod(event).toUpperCase();
    const path = getPath(event);

    if (method === "OPTIONS") return json(204, null);

    if (path === ROUTE_BASE) {
      if (method === "GET") return handleList(event);
      if (method === "POST") return handleCreate(event);
      return badRequest(`Unsupported method ${method} for ${ROUTE_BASE}`);
    }

    if (path.startsWith(`${ROUTE_BASE}/`)) {
      const assetId = decodeURIComponent(path.slice(`${ROUTE_BASE}/`.length)).trim();
      if (!assetId) return badRequest("assetId is required");

      if (method === "GET") return handleGet(event, assetId);
      if (method === "PATCH") return handleUpdate(event, assetId);
      if (method === "DELETE") return handleDelete(event, assetId);
      return badRequest(`Unsupported method ${method} for ${ROUTE_BASE}/{assetId}`);
    }

    return notFound();
  } catch (e) {
    // If JWT authorizer is configured, missing/invalid token yields 401 at API Gateway,
    // but keep a safe fallback.
    const msg = String(e?.message || e);
    if (msg.toLowerCase().includes("unauthorized")) return json(401, { message: "Unauthorized" });
    return json(500, { message: "Internal Server Error", detail: msg });
  }
};
