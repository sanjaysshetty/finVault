const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// ✅ IMPORTANT: default table name so GET /spending doesn't 500 if env var missing
const TABLE_NAME = process.env.TABLE_NAME || "ReceiptLedger";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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

  ExpressionAttributeNames["#updatedAt"] = "updatedAt";
  ExpressionAttributeValues[":updatedAt"] = new Date().toISOString();
  sets.push("#updatedAt = :updatedAt");

  return {
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames,
    ExpressionAttributeValues,
  };
}

/* -------------------- Handlers -------------------- */

async function listSpending(event) {
  requireTableName();

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

  // Optional date query via GSI1 (if you have it)
  const date = (qs.date || "").trim();
  if (date) {
    const d = normalizeDateYYYYMMDD(date);

    const resp = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: "GSI1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `DATE#${d}` },
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );

    const nextTokenOut = resp.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(resp.LastEvaluatedKey), "utf8").toString("base64")
      : null;

    return json(200, { items: resp.Items || [], nextToken: nextTokenOut });
  }

  const resp = await ddb.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
    })
  );

  const nextTokenOut = resp.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(resp.LastEvaluatedKey), "utf8").toString("base64")
    : null;

  return json(200, { items: resp.Items || [], nextToken: nextTokenOut });
}

// Old style: receipt -> pk=RECEIPT#receipt
async function getReceipt(event) {
  requireTableName();

  const receipt = normalizeReceipt(event.pathParameters?.receipt);
  const pk = `RECEIPT#${receipt}`;

  const resp = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );

  return json(200, { receipt, items: resp.Items || [] });
}

// (Optional) create uses LINE#000001 format. Keep for compatibility.
async function createItem(event) {
  requireTableName();

  const body = parseBody(event);

  const receipt = String(body.receipt || "").trim();
  const lineId = normalizeLineId(body.lineId);

  const pk = `RECEIPT#${receipt}`;
  const sk = `LINE#${pad6(lineId)}`;

  const d = body.date ? normalizeDateYYYYMMDD(body.date) : "";

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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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

// OLD update: receipt + lineId => LINE#000002
async function updateItemByReceiptLine(event) {
  requireTableName();

  const receipt = normalizeReceipt(event.pathParameters?.receipt);
  const lineId = normalizeLineId(event.pathParameters?.lineId);
  const body = parseBody(event);

  const pk = `RECEIPT#${receipt}`;
  const sk = `LINE#${pad6(lineId)}`;

  const { UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues } =
    buildUpdateExpression(body);

  const resp = await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk },
      UpdateExpression,
      ExpressionAttributeNames,
      ExpressionAttributeValues,
      ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk)",
      ReturnValues: "ALL_NEW",
    })
  );

  return json(200, { ok: true, item: resp.Attributes });
}

// ✅ NEW update: true pk/sk (supports ITEM#0001 etc)
async function updateItemByPkSk(event) {
  requireTableName();

  const pk = decodeURIComponent(event.pathParameters?.pk || "").trim();
  const sk = decodeURIComponent(event.pathParameters?.sk || "").trim();
  if (!pk) throw new Error("Missing pk");
  if (!sk) throw new Error("Missing sk");

  const body = parseBody(event);

  const { UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues } =
    buildUpdateExpression(body);

  const resp = await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk },
      UpdateExpression,
      ExpressionAttributeNames,
      ExpressionAttributeValues,
      ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk)",
      ReturnValues: "ALL_NEW",
    })
  );

  return json(200, { ok: true, item: resp.Attributes });
}

async function deleteItemByReceiptLine(event) {
  requireTableName();

  const receipt = normalizeReceipt(event.pathParameters?.receipt);
  const lineId = normalizeLineId(event.pathParameters?.lineId);

  const pk = `RECEIPT#${receipt}`;
  const sk = `LINE#${pad6(lineId)}`;

  await ddb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk },
      ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk)",
    })
  );

  return json(200, { ok: true });
}

// ✅ NEW delete: true pk/sk
async function deleteItemByPkSk(event) {
  requireTableName();

  const pk = decodeURIComponent(event.pathParameters?.pk || "").trim();
  const sk = decodeURIComponent(event.pathParameters?.sk || "").trim();
  if (!pk) throw new Error("Missing pk");
  if (!sk) throw new Error("Missing sk");

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

    // List / create
    if (method === "GET" && rawPath === "/spending") return await listSpending(event);
    if (method === "POST" && rawPath === "/spending") return await createItem(event);

    // Receipt query
    if (method === "GET" && rawPath.startsWith("/spending/receipt/"))
      return await getReceipt(event);

    // ✅ NEW pk/sk update/delete routes
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

    if (msg.includes("ConditionalCheckFailed")) return json(404, { error: "Item not found" });
    if (msg.includes("Invalid JSON")) return json(400, { error: msg });
    if (msg.includes("No editable fields")) return json(400, { error: msg });
    if (msg.includes("Missing") || msg.includes("Invalid")) return json(400, { error: msg });

    return json(500, { error: "Server error", detail: msg });
  }
};
