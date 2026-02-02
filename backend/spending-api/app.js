const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

// ✅ default table name so GET /spending doesn't 500 if env var missing
const TABLE_NAME = process.env.TABLE_NAME || "StoreReceiptLedger";
const DATE_INDEX_NAME = process.env.DATE_INDEX_NAME || "UserDateIndex";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
}

function json(statusCode, bodyObj) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: bodyObj === "" ? "" : JSON.stringify(bodyObj),
  };
}

function requireTableName() {
  if (!TABLE_NAME) throw new Error("Server misconfigured: TABLE_NAME is not set");
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function getUserIdFromJwt(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims || {};
  const sub = claims.sub;
  if (!sub) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
  return sub;
}

function normalizeReceipt(receiptParam) {
  const receipt = decodeURIComponent(receiptParam || "").trim();
  if (!receipt) throw new Error("Missing receipt");
  return receipt;
}

function normalizeLineId(lineIdParam) {
  const n = Number(lineIdParam);
  if (!Number.isInteger(n) || n <= 0) throw new Error("Invalid lineId");
  return n;
}

function pad6(n) {
  return String(n).padStart(6, "0");
}

function toNumber(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

function normalizeDateYYYYMMDD(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  const d = s.slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error("Invalid date format (expected YYYY-MM-DD)");
  }
  const dt = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) throw new Error("Invalid date value");
  const roundTrip = dt.toISOString().slice(0, 10);
  if (roundTrip !== d) throw new Error("Invalid calendar date");

  return d;
}

function addDays(iso, days) {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function dateRange(startISO, endISO) {
  const out = [];
  let cur = startISO;
  while (cur <= endISO) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/**
 * Editable fields:
 *  - productDescription
 *  - category
 *  - amount
 *  - date (YYYY-MM-DD) -> also updates gsi1pk
 */
function buildUpdateExpression(input) {
  const allowed = {};

  if (typeof input.productDescription === "string") {
    allowed.productDescription = input.productDescription.trim();
  }

  if (typeof input.category === "string") {
    allowed.category = input.category.trim();
  }

  if (input.amount !== undefined) {
    allowed.amount = toNumber(input.amount);
  }

  if (input.date !== undefined) {
    const d = normalizeDateYYYYMMDD(input.date);
    if (d) {
      allowed.date = d;
      // NOTE: This assumes you have a date-based GSI (gsi1pk).
      // If your GSI1 is now curationKey/curationSort, this still won’t break updates,
      // but date queries will fall back to Scan.
      allowed.gsi1pk = `DATE#${d}`;
    }
  }

  const keys = Object.keys(allowed);
  if (keys.length === 0) {
    throw new Error(
      "No editable fields provided. Allowed: productDescription, category, amount, date"
    );
  }

  const ExpressionAttributeNames = {};
  const ExpressionAttributeValues = {};
  const sets = [];

  for (const k of keys) {
    const nameKey = `#${k}`;
    const valueKey = `:${k}`;
    ExpressionAttributeNames[nameKey] = k;
    ExpressionAttributeValues[valueKey] = allowed[k];
    sets.push(`${nameKey} = ${valueKey}`);
  }

  return {
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames,
    ExpressionAttributeValues,
  };
}

/**
 * ✅ Adds curation “dirty” flags to ANY update.
 * We keep these on the RAW row so the nightly batch can find deltas without streams.
 */
function addCurationToUpdate(exprObj, pk, sk) {
  const now = new Date().toISOString();

  const names = exprObj.ExpressionAttributeNames || {};
  const values = exprObj.ExpressionAttributeValues || {};

  names["#updatedAt"] = "updatedAt";
  values[":updatedAt"] = now;

  names["#needsCuration"] = "needsCuration";
  values[":needsCuration"] = true;

  names["#curationKey"] = "curationKey";
  values[":curationKey"] = "CURATION";

  names["#curationSort"] = "curationSort";
  values[":curationSort"] = `NEEDS#${now}#${pk}#${sk}`;

  // Append to existing UpdateExpression
  const base = exprObj.UpdateExpression || "SET";
  const suffix = [
    "#updatedAt = :updatedAt",
    "#needsCuration = :needsCuration",
    "#curationKey = :curationKey",
    "#curationSort = :curationSort",
  ].join(", ");

  const joined =
    base.trim().toUpperCase() === "SET"
      ? `SET ${suffix}`
      : `${base}, ${suffix}`;

  return {
    UpdateExpression: joined,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

async function getItemOrNull(pk, sk) {
  const resp = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk },
    })
  );
  return resp.Item || null;
}

function assertOwned(item, userId) {
  if (!item) {
    const err = new Error("Item not found");
    err.statusCode = 404;
    throw err;
  }
  if (!item.userId) {
    const err = new Error("Forbidden");
    err.statusCode = 403;
    throw err;
  }
  if (item.userId !== userId) {
    const err = new Error("Forbidden");
    err.statusCode = 403;
    throw err;
  }
}

/* ---------------- Dashboard helpers ---------------- */

function canonCategory(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[\/_,.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// map near-duplicates to a canonical display label
function normalizeCategory(raw) {
  const c = canonCategory(raw);

  if (!c) return "Uncategorized";

  // tax always wins
  if (c.includes("tax")) return "Tax";

  const map = [
    { keys: ["pantry", "snack", "snacks"], label: "Pantry & Snacks" },
    { keys: ["produce", "fruit", "vegetable"], label: "Produce" },
    { keys: ["dairy", "milk", "egg"], label: "Dairy" },
    { keys: ["meat", "seafood"], label: "Meat & Seafood" },
    { keys: ["beverage", "drink"], label: "Beverages" },
    { keys: ["bakery", "bread"], label: "Bakery" },
    { keys: ["frozen"], label: "Frozen" },
    { keys: ["household", "paper", "home supply", "clean"], label: "Household" },
    { keys: ["personal care", "health", "beauty"], label: "Personal Care" },
    { keys: ["pharmacy", "medicine", "vitamin"], label: "Pharmacy" },
    { keys: ["deli"], label: "Deli" },
    { keys: ["prepared", "ready to eat"], label: "Prepared Foods" },
  ];

  for (const m of map) {
    if (m.keys.some((k) => c.includes(k))) return m.label;
  }

  // title-case fallback
  return c
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function shouldExcludeLine(item) {
  const desc = String(item?.productDescription || "").trim().toUpperCase();
  if (!desc) return false;

  if (desc.includes("SUBTOTAL")) return true;
  if (desc === "TOTAL" || desc.includes(" TOTAL")) return true;
  if (desc.includes("BALANCE DUE")) return true;
  if (desc.includes("AMOUNT DUE")) return true;

  return false;
}

function isTaxLine(item) {
  const desc = String(item?.productDescription || "").trim().toUpperCase();
  const cat = String(item?.category || "");
  return desc.includes("TAX") || canonCategory(cat).includes("tax");
}

async function queryAllForDateRange(userId, startISO, endISO) {
  // Preferred: Query a GSI with pk=userId, sk=date (YYYY-MM-DD)
  let lastKey = undefined;
  const all = [];

  try {
    do {
      const resp = await ddb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: DATE_INDEX_NAME,
          KeyConditionExpression: "#uid = :uid AND #date BETWEEN :s AND :e",
          ExpressionAttributeNames: { "#uid": "userId", "#date": "date" },
          ExpressionAttributeValues: { ":uid": userId, ":s": startISO, ":e": endISO },
          ExclusiveStartKey: lastKey,
        })
      );

      if (resp.Items?.length) all.push(...resp.Items);
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    return all;
  } catch (e) {
    // Fallback scan by user + date range (works but slower)
    const msg = String(e?.message || e);
    console.log("Date range query failed; falling back to Scan. Error:", msg);

    let scanLast = undefined;
    do {
      const sresp = await ddb.send(
        new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: "#uid = :uid AND #date BETWEEN :s AND :e",
          ExpressionAttributeNames: { "#uid": "userId", "#date": "date" },
          ExpressionAttributeValues: { ":uid": userId, ":s": startISO, ":e": endISO },
          ExclusiveStartKey: scanLast,
        })
      );

      if (sresp.Items?.length) all.push(...sresp.Items);
      scanLast = sresp.LastEvaluatedKey;
    } while (scanLast);

    return all;
  }
}

async function queryAllForDate(userId, dISO) {
  // Prefer date-GSI query; if GSI schema changed, fall back to Scan.
  const pk = `DATE#${dISO}`;
  let lastKey = undefined;
  const all = [];

  try {
    do {
      const resp = await ddb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: "GSI1",
          KeyConditionExpression: "gsi1pk = :pk",
          ExpressionAttributeValues: { ":pk": pk, ":uid": userId },
          FilterExpression: "#uid = :uid",
          ExpressionAttributeNames: { "#uid": "userId" },
          ExclusiveStartKey: lastKey,
        })
      );

      if (resp.Items?.length) all.push(...resp.Items);
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    return all;
  } catch (e) {
    // fallback scan by date + user
    const msg = String(e?.message || e);
    console.log("GSI1 date query failed; falling back to Scan. Error:", msg);

    let scanLast = undefined;
    do {
      const sresp = await ddb.send(
        new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: "#uid = :uid AND #date = :d",
          ExpressionAttributeNames: { "#uid": "userId", "#date": "date" },
          ExpressionAttributeValues: { ":uid": userId, ":d": dISO },
          ExclusiveStartKey: scanLast,
        })
      );
      if (sresp.Items?.length) all.push(...sresp.Items);
      scanLast = sresp.LastEvaluatedKey;
    } while (scanLast);

    return all;
  }
}

/* -------------------- Handlers -------------------- */

async function listSpending(event) {
  requireTableName();
  const userId = getUserIdFromJwt(event);

  const qs = event.queryStringParameters || {};
  const limit = Math.max(1, Math.min(200, Number(qs.limit) || 50));

  let exclusiveStartKey = undefined;
  if (qs.nextToken) {
    try {
      exclusiveStartKey = JSON.parse(
        Buffer.from(qs.nextToken, "base64").toString("utf8")
      );
    } catch {
      throw new Error("Invalid nextToken");
    }
  }

  // Optional date query via GSI1 (preferred). If GSI is not date-based, fallback to Scan.
  const date = (qs.date || "").trim();
  if (date) {
    const d = normalizeDateYYYYMMDD(date);

    try {
      const resp = await ddb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: "GSI1",
          KeyConditionExpression: "gsi1pk = :pk",
          ExpressionAttributeValues: { ":pk": `DATE#${d}`, ":uid": userId },
          FilterExpression: "#uid = :uid",
          ExpressionAttributeNames: { "#uid": "userId" },
          Limit: limit,
          ExclusiveStartKey: exclusiveStartKey,
        })
      );

      const nextTokenOut = resp.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(resp.LastEvaluatedKey), "utf8").toString("base64")
        : null;

      return json(200, { items: resp.Items || [], nextToken: nextTokenOut });
    } catch (e) {
      const msg = String(e?.message || e);
      console.log("GSI1 date list query failed; falling back to Scan. Error:", msg);

      const resp = await ddb.send(
        new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: "#uid = :uid AND #date = :d",
          ExpressionAttributeNames: { "#uid": "userId", "#date": "date" },
          ExpressionAttributeValues: { ":uid": userId, ":d": d },
          Limit: limit,
          ExclusiveStartKey: exclusiveStartKey,
        })
      );

      const nextTokenOut = resp.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(resp.LastEvaluatedKey), "utf8").toString("base64")
        : null;

      return json(200, { items: resp.Items || [], nextToken: nextTokenOut });
    }
  }

  // Fallback: Scan and filter by userId
  const resp = await ddb.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "#uid = :uid",
      ExpressionAttributeNames: { "#uid": "userId" },
      ExpressionAttributeValues: { ":uid": userId },
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
    })
  );

  const nextTokenOut = resp.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(resp.LastEvaluatedKey), "utf8").toString("base64")
    : null;

  return json(200, { items: resp.Items || [], nextToken: nextTokenOut });
}

async function spendingDashboard(event) {
  requireTableName();
  const userId = getUserIdFromJwt(event);
  const qs = event.queryStringParameters || {};

  const today = new Date().toISOString().slice(0, 10);
  const defaultStart = addDays(today, -29);

  const start = normalizeDateYYYYMMDD(qs.start || defaultStart);
  const end = normalizeDateYYYYMMDD(qs.end || today);
  if (start > end) throw new Error("start must be <= end");

  const filterCategoryRaw = String(qs.category || "").trim();
  const filterCategory =
    !filterCategoryRaw || filterCategoryRaw.toLowerCase() === "all"
      ? "All"
      : normalizeCategory(filterCategoryRaw);

  const items = await queryAllForDateRange(userId, start, end);

  let totalSpend = 0;
  const byCategory = new Map();

  for (const it of items) {
    if (shouldExcludeLine(it)) continue;

    const amt = Number(it.amount);
    if (!Number.isFinite(amt)) continue;

    const cat = isTaxLine(it) ? "Tax" : normalizeCategory(it.category);

    if (filterCategory !== "All" && cat !== filterCategory) continue;

    totalSpend += amt;
    byCategory.set(cat, (byCategory.get(cat) || 0) + amt);
  }

  const chart = Array.from(byCategory.entries())
    .map(([category, amount]) => ({ category, amount: Number(amount.toFixed(2)) }))
    .sort((a, b) => b.amount - a.amount);

  const categories = ["All", ...chart.map((x) => x.category)];

  return json(200, {
    start,
    end,
    category: filterCategory,
    totalSpend: Number(totalSpend.toFixed(2)),
    chart: chart.slice(0, 10),
    categories,
  });
}

async function spendingDashboardDetails(event) {
  requireTableName();
  const userId = getUserIdFromJwt(event);
  const qs = event.queryStringParameters || {};

  const today = new Date().toISOString().slice(0, 10);
  const defaultStart = addDays(today, -29);

  const start = normalizeDateYYYYMMDD(qs.start || defaultStart);
  const end = normalizeDateYYYYMMDD(qs.end || today);
  if (start > end) throw new Error("start must be <= end");

  const rawCat = String(qs.category || "").trim();
  if (!rawCat) throw new Error("category is required");

  const category = normalizeCategory(rawCat);

  const items = await queryAllForDateRange(userId, start, end);

  const out = [];
  let total = 0;

  for (const it of items) {
    if (shouldExcludeLine(it)) continue;

    const amt = Number(it.amount);
    if (!Number.isFinite(amt)) continue;

    const cat = isTaxLine(it) ? "Tax" : normalizeCategory(it.category);
    if (cat !== category) continue;

    total += amt;

    out.push({
      pk: it.pk,
      sk: it.sk,
      date: it.date || "",
      receipt: it.receipt || "",
      lineId: it.lineId ?? "",
      productCode: it.productCode || "",
      productDescription: it.productDescription || "",
      amount: amt,
      category: cat,
    });
  }

  // Sort for a nice UX: largest first
  out.sort((a, b) => Number(b.amount) - Number(a.amount));

  return json(200, {
    start,
    end,
    category,
    total: Number(total.toFixed(2)),
    count: out.length,
    items: out,
  });
}

// receipt -> pk=RECEIPT#receipt
async function getReceipt(event) {
  requireTableName();
  const userId = getUserIdFromJwt(event);

  const receipt = normalizeReceipt(event.pathParameters?.receipt);
  const pk = `RECEIPT#${receipt}`;

  const resp = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk, ":uid": userId },
      FilterExpression: "#uid = :uid",
      ExpressionAttributeNames: { "#uid": "userId" },
    })
  );

  return json(200, { receipt, items: resp.Items || [] });
}

// create uses LINE#000001 format. Keep for compatibility.
async function createItem(event) {
  requireTableName();
  const userId = getUserIdFromJwt(event);

  const body = parseBody(event);

  const receipt = String(body.receipt || "").trim();
  const lineId = normalizeLineId(body.lineId);

  const pk = `RECEIPT#${receipt}`;
  const sk = `LINE#${pad6(lineId)}`;

  const d = body.date ? normalizeDateYYYYMMDD(body.date) : "";

  const now = new Date().toISOString();

  const item = {
    pk,
    sk,
    receipt,
    lineId,
    productCode: body.productCode ? String(body.productCode) : "",
    productDescription:
      typeof body.productDescription === "string" ? body.productDescription.trim() : "",
    date: d || "",
    amount: toNumber(body.amount),
    category: typeof body.category === "string" ? body.category.trim() : "",
    gsi1pk: d ? `DATE#${d}` : "DATE#UNKNOWN",
    gsi1sk: `${pk}#${sk}`,
    userId,
    createdAt: now,

    // ✅ curation queue markers (batch-based)
    updatedAt: now,
    needsCuration: true,
    curationKey: "CURATION",
    curationSort: `NEEDS#${now}#${pk}#${sk}`,
  };

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
      ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    })
  );

  return json(201, { ok: true, item });
}

// OLD update: receipt + lineId
async function updateItemByReceiptLine(event) {
  requireTableName();
  const userId = getUserIdFromJwt(event);

  const receipt = normalizeReceipt(event.pathParameters?.receipt);
  const lineId = normalizeLineId(event.pathParameters?.lineId);
  const body = parseBody(event);

  const pk = `RECEIPT#${receipt}`;
  const sk = `LINE#${pad6(lineId)}`;

  const existing = await getItemOrNull(pk, sk);
  assertOwned(existing, userId);

  let expr = buildUpdateExpression(body);
  expr = addCurationToUpdate(expr, pk, sk);

  const resp = await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk },
      UpdateExpression: expr.UpdateExpression,
      ExpressionAttributeNames: expr.ExpressionAttributeNames,
      ExpressionAttributeValues: expr.ExpressionAttributeValues,
      ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk)",
      ReturnValues: "ALL_NEW",
    })
  );

  return json(200, { ok: true, item: resp.Attributes });
}

// ✅ pk/sk update
async function updateItemByPkSk(event) {
  requireTableName();
  const userId = getUserIdFromJwt(event);

  const pk = decodeURIComponent(event.pathParameters?.pk || "").trim();
  const sk = decodeURIComponent(event.pathParameters?.sk || "").trim();
  if (!pk) throw new Error("Missing pk");
  if (!sk) throw new Error("Missing sk");

  const existing = await getItemOrNull(pk, sk);
  assertOwned(existing, userId);

  const body = parseBody(event);

  let expr = buildUpdateExpression(body);
  expr = addCurationToUpdate(expr, pk, sk);

  const resp = await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk },
      UpdateExpression: expr.UpdateExpression,
      ExpressionAttributeNames: expr.ExpressionAttributeNames,
      ExpressionAttributeValues: expr.ExpressionAttributeValues,
      ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk)",
      ReturnValues: "ALL_NEW",
    })
  );

  return json(200, { ok: true, item: resp.Attributes });
}

async function deleteItemByReceiptLine(event) {
  requireTableName();
  const userId = getUserIdFromJwt(event);

  const receipt = normalizeReceipt(event.pathParameters?.receipt);
  const lineId = normalizeLineId(event.pathParameters?.lineId);

  const pk = `RECEIPT#${receipt}`;
  const sk = `LINE#${pad6(lineId)}`;

  const existing = await getItemOrNull(pk, sk);
  assertOwned(existing, userId);

  await ddb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk },
      ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk)",
    })
  );

  return json(200, { ok: true });
}

// ✅ pk/sk delete
async function deleteItemByPkSk(event) {
  requireTableName();
  const userId = getUserIdFromJwt(event);

  const pk = decodeURIComponent(event.pathParameters?.pk || "").trim();
  const sk = decodeURIComponent(event.pathParameters?.sk || "").trim();
  if (!pk) throw new Error("Missing pk");
  if (!sk) throw new Error("Missing sk");

  const existing = await getItemOrNull(pk, sk);
  assertOwned(existing, userId);

  await ddb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk },
      ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk)",
    })
  );

  return json(200, { ok: true });
}

/* -------------------- Router -------------------- */

exports.handler = async (event) => {
  try {
    const method = event?.requestContext?.http?.method;
    if (method === "OPTIONS") return json(200, "");

    const rawPath = event?.rawPath || "";

    // ✅ Dashboard aggregates
    if (method === "GET" && rawPath === "/spending/dashboard/details")
      return await spendingDashboardDetails(event);

    if (method === "GET" && rawPath === "/spending/dashboard")
      return await spendingDashboard(event);

    // List / create
    if (method === "GET" && rawPath === "/spending") return await listSpending(event);
    if (method === "POST" && rawPath === "/spending") return await createItem(event);

    // Receipt query
    if (method === "GET" && rawPath.startsWith("/spending/receipt/"))
      return await getReceipt(event);

    // pk/sk update/delete
    if (method === "PATCH" && rawPath.startsWith("/spending/item/"))
      return await updateItemByPkSk(event);

    if (method === "DELETE" && rawPath.startsWith("/spending/item/"))
      return await deleteItemByPkSk(event);

    // Backward compatible routes
    if (method === "PATCH" && rawPath.includes("/spending/receipt/") && rawPath.includes("/line/"))
      return await updateItemByReceiptLine(event);

    if (method === "DELETE" && rawPath.includes("/spending/receipt/") && rawPath.includes("/line/"))
      return await deleteItemByReceiptLine(event);

    return json(404, { error: "Not Found", method, path: rawPath });
  } catch (e) {
    const msg = String(e?.message || e);

    const code =
      e?.statusCode ||
      (msg.includes("Unauthorized")
        ? 401
        : msg.includes("Forbidden")
        ? 403
        : msg.includes("ConditionalCheckFailed")
        ? 404
        : msg.includes("Invalid JSON")
        ? 400
        : msg.includes("No editable fields")
        ? 400
        : msg.includes("Missing") || msg.includes("Invalid")
        ? 400
        : 500);

    if (code === 404) return json(404, { error: "Item not found" });
    if (code === 401) return json(401, { error: "Unauthorized" });
    if (code === 403) return json(403, { error: "Forbidden" });

    return json(code, { error: code === 500 ? "Server error" : "Bad Request", detail: msg });
  }
};
