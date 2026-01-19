const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.TABLE_NAME;

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

function normalizeReceipt(receiptParam) {
  // receiptParam is like "01_06_2023.pdf" (from path)
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

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

/**
 * Editable fields only:
 *  - productDescription
 *  - category
 *  - amount
 */
function buildUpdateExpression(input) {
  const allowed = {};
  if (typeof input.productDescription === "string")
    allowed.productDescription = input.productDescription.trim();
  if (typeof input.category === "string") allowed.category = input.category.trim();
  if (input.amount !== undefined) allowed.amount = toNumber(input.amount);

  const keys = Object.keys(allowed);
  if (keys.length === 0) {
    throw new Error("No editable fields provided. Allowed: productDescription, category, amount");
  }

  // Build UpdateExpression safely
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

  // Always update updatedAt
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
  // Supports optional query params:
  //  - limit (default 50, max 200)
  //  - nextToken (DynamoDB LastEvaluatedKey as base64 JSON)
  //  - date=YYYY-MM-DD (uses GSI1 if you have it)
  const qs = event.queryStringParameters || {};
  const limit = Math.max(1, Math.min(200, Number(qs.limit) || 50));

  let exclusiveStartKey = undefined;
  if (qs.nextToken) {
    try {
      exclusiveStartKey = JSON.parse(Buffer.from(qs.nextToken, "base64").toString("utf8"));
    } catch {
      throw new Error("Invalid nextToken");
    }
  }

  // If date provided and you created GSI1 during table creation:
  const date = (qs.date || "").trim();
  if (date) {
    const resp = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: "GSI1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: {
          ":pk": `DATE#${date}`,
        },
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );

    const nextTokenOut = resp.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(resp.LastEvaluatedKey), "utf8").toString("base64")
      : null;

    return json(200, {
      items: resp.Items || [],
      nextToken: nextTokenOut,
    });
  }

  // Fallback: scan (fine for small datasets; 1879 rows is OK)
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

  return json(200, {
    items: resp.Items || [],
    nextToken: nextTokenOut,
  });
}

async function getReceipt(event) {
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

async function createItem(event) {
  const body = parseBody(event);

  // Required for creating a new line
  const receipt = String(body.receipt || "").trim();
  const lineId = normalizeLineId(body.lineId);

  const pk = `RECEIPT#${receipt}`;
  const sk = `LINE#${pad6(lineId)}`;

  // Allow creating only with standard fields; editable fields included
  const item = {
    pk,
    sk,
    receipt,
    lineId,
    productCode: body.productCode ? String(body.productCode) : "",
    productDescription: typeof body.productDescription === "string" ? body.productDescription.trim() : "",
    date: body.date ? String(body.date).slice(0, 10) : "",
    amount: toNumber(body.amount),
    category: typeof body.category === "string" ? body.category.trim() : "",
    // Optional GSI1 if date exists
    gsi1pk: body.date ? `DATE#${String(body.date).slice(0, 10)}` : "DATE#UNKNOWN",
    gsi1sk: `${pk}#${sk}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Prevent accidental overwrite
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
      ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    })
  );

  return json(201, { ok: true, item });
}

async function updateItem(event) {
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

async function deleteItem(event) {
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

/* -------------------- Router -------------------- */

exports.handler = async (event) => {
  try {
    const method = event?.requestContext?.http?.method;

    if (method === "OPTIONS") return json(200, "");

    const routeKey = event?.requestContext?.http?.path || "";
    // We’ll route by rawPath + method via pattern checks
    const rawPath = event?.rawPath || "";

    // GET /spending
    if (method === "GET" && rawPath === "/spending") return await listSpending(event);

    // POST /spending
    if (method === "POST" && rawPath === "/spending") return await createItem(event);

    // GET /spending/receipt/{receipt}
    if (method === "GET" && rawPath.startsWith("/spending/receipt/")) return await getReceipt(event);

    // PATCH /spending/receipt/{receipt}/line/{lineId}
    if (method === "PATCH" && rawPath.includes("/spending/receipt/") && rawPath.includes("/line/"))
      return await updateItem(event);

    // DELETE /spending/receipt/{receipt}/line/{lineId}
    if (method === "DELETE" && rawPath.includes("/spending/receipt/") && rawPath.includes("/line/"))
      return await deleteItem(event);

    return json(404, { error: "Not Found", method, path: rawPath });
  } catch (e) {
    const msg = String(e?.message || e);
    // Map some common DynamoDB conditional errors
    if (msg.includes("ConditionalCheckFailed")) {
      return json(404, { error: "Item not found" });
    }
    if (msg.includes("Invalid JSON")) {
      return json(400, { error: msg });
    }
    if (msg.includes("No editable fields")) {
      return json(400, { error: msg });
    }
    if (msg.includes("Missing") || msg.includes("Invalid")) {
      return json(400, { error: msg });
    }
    return json(500, { error: "Server error", detail: msg });
  }
};
