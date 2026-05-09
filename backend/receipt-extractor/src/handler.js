// backend/receipt-extractor/src/handler.js
//
// S3-triggered receipt extractor Lambda (images only).
// receiptId format: <StoreName>_<MM-DD-YYYY>_<UniqueID>
// Example: Costco_01-24-2026_feffa2087d299d5d
//
// Required env vars:
//   ANTHROPIC_API_KEY
//   RECEIPT_LEDGER_TABLE
//
// Optional env vars:
//   ANTHROPIC_MODEL (default: claude-sonnet-4-6)
//   RECEIPT_KEY_PREFIX (default: receipts/ ; set to "" to disable prefix filtering)

import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";

// AWS clients
const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/* -------------------- Category taxonomy -------------------- */

const CATEGORY_SYSTEM_PROMPT = `You extract structured receipt data from images.

CATEGORY GUIDANCE:
Assign a category to every line item. Use broad, meaningful categories — aim for roughly 10 across all your receipts, give or take a few. Avoid creating overly granular or one-off categories. Good examples: Groceries, Produce, Meat & Seafood, Dairy & Eggs, Beverages, Household, Personal Care, Health & Medicine, Dining & Restaurant, Electronics, Clothing, Fuel & Auto, Other. You are not limited to this list — use your best judgment to pick a short, consistent label that would make sense across many receipts.

Category reasoning rules:
- Be specific when the item clearly belongs to a sub-category (e.g., fresh apples → Produce, not Groceries).
- If a product code is present, use it to confirm (e.g., PLU codes 3000–4999 → Produce).
- For combo items (e.g., "Rotisserie Chicken"), use the dominant component (Meat & Seafood).
- NEVER leave category null or empty. If genuinely uncertain, use "Other".
- Summary rows (SUBTOTAL, TAX, TOTAL) always get category "SUMMARY" — handled separately, not by you.

Receipt extraction rules:
- "lines" must contain ONLY purchasable item lines (actual products purchased).
- Exclude payment method lines (VISA/CASH/debit), loyalty points, coupon adjustments, membership fees.
- "summaryLines" MUST include exactly three objects: SUBTOTAL, TAX, TOTAL (amount can be null if not printed).
- Keep product codes exactly as printed on the receipt (e.g., "738435" or "4011").
- If a field other than category is missing or illegible, use null.`;

/* -------------------- Helpers -------------------- */

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

function decodeS3Key(rawKey) {
  return decodeURIComponent(String(rawKey || "").replace(/\+/g, " "));
}

function guessMimeType(contentType, key) {
  if (contentType && contentType.includes("/")) return contentType;
  const lower = (key || "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

/**
 * Deterministic unique id derived from S3 bucket+key.
 */
function buildUniqueIdFromS3(bucket, key) {
  return crypto
    .createHash("sha256")
    .update(`${bucket}:${key}`)
    .digest("hex")
    .slice(0, 16);
}

function simplifyStoreName(store) {
  const raw = String(store ?? "").trim();
  if (!raw) return "UnknownStore";

  const upper = raw.toUpperCase();

  if (upper.includes("COSTCO")) return "Costco";
  if (upper.includes("WALMART") || upper.includes("WAL-MART")) return "Walmart";
  if (upper.includes("TARGET")) return "Target";
  if (upper.includes("KROGER")) return "Kroger";
  if (upper.includes("WHOLE FOODS")) return "WholeFoods";
  if (upper.includes("99")) return "99 Ranch";
  if (upper.includes("HEB") || upper.includes("H-E-B")) return "HEB";
  if (upper.includes("TRIVENI")) return "Triveni";
  if (upper.includes("IBC")) return "IBC";
  if (upper.includes("KEEMAT")) return "Keemat";
  if (upper.includes("ALDI")) return "Aldi";
  if (upper.includes("TRADER JOE")) return "TraderJoes";
  if (upper.includes("SAFEWAY")) return "Safeway";

  const token = raw
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)[0];

  if (!token) return "UnknownStore";
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

/**
 * Convert YYYY-MM-DD -> MM-DD-YYYY
 */
function formatReceiptDateMMDDYYYY(purchaseDate) {
  const s = String(purchaseDate ?? "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "UnknownDate";
  const [, yyyy, mm, dd] = m;
  return `${mm}-${dd}-${yyyy}`;
}

function getCurrentDateYYYYMMDD() {
  const now = new Date();
  if (Number.isNaN(now.getTime())) return null;
  return now.toISOString().slice(0, 10);
}

function isYYYYMMDD(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "").trim());
}

function resolvePurchaseDate(purchaseDate) {
  const normalized = String(purchaseDate ?? "").trim();
  if (isYYYYMMDD(normalized)) return normalized;
  return getCurrentDateYYYYMMDD();
}

function resolveReceiptDateForKey(purchaseDate) {
  return resolvePurchaseDate(purchaseDate) ?? "UnknownDate";
}

/**
 * Final format:
 *   <Store>_<MM-DD-YYYY>_<UniqueID>
 */
function buildReceiptId({ store, purchaseDate, uniqueId }) {
  const storePart = simplifyStoreName(store);
  const datePart = formatReceiptDateMMDDYYYY(resolveReceiptDateForKey(purchaseDate));
  return `${storePart}_${datePart}_${uniqueId}`;
}

function shouldProcessKey(key) {
  const prefix = process.env.RECEIPT_KEY_PREFIX ?? "receipts/";
  if (prefix && !key.startsWith(prefix)) return false;
  return true;
}

async function resolveUserIdFromS3({ bucket, key }) {
  // 1) Try metadata (best)
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const meta = head?.Metadata || {};
    if (meta.userid) return String(meta.userid);
    if (meta.userId) return String(meta.userId);
  } catch (e) {
    console.log("HeadObject metadata lookup failed (continuing):", String(e?.message || e));
  }

  // 2) Fallback: parse from key receipts/<userId>/...
  const parts = String(key || "").split("/");
  const idx = parts.indexOf("receipts");
  if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];

  // Or: prefix/<userId>/...
  if (parts.length >= 2) return parts[1];

  return "";
}

/**
 * Batch curation keys (for querying NEEDS rows via GSI1)
 * GSI1: curationKey (HASH) + curationSort (RANGE)
 */
function makeCurationFields({ nowIso, pk, sk }) {
  return {
    needsCuration: true,
    curationKey: "CURATION",
    curationSort: `NEEDS#${nowIso}#${pk}#${sk}`,
  };
}

function buildReceiptToolSchema() {
  return {
    type: "object",
    properties: {
      receipt: {
        type: "object",
        properties: {
          store: { type: ["string", "null"] },
          purchaseDate: { type: ["string", "null"], description: "YYYY-MM-DD if present; otherwise null" },
          currency: { type: ["string", "null"], description: "e.g., USD" },
        },
        required: ["store", "purchaseDate", "currency"],
      },
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            lineId: { type: "integer" },
            productCode: { type: ["string", "null"] },
            productDescription: { type: ["string", "null"] },
            amount: { type: ["number", "null"] },
            category: { type: "string", description: "One of the 10 allowed categories from the system prompt. Never null." },
            rawText: { type: ["string", "null"] },
          },
          required: ["lineId", "productCode", "productDescription", "amount", "category", "rawText"],
        },
      },
      summaryLines: {
        type: "array",
        description: "Must include exactly: SUBTOTAL, TAX, TOTAL (amount can be null if missing).",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["SUBTOTAL", "TAX", "TOTAL"] },
            amount: { type: ["number", "null"] },
            rawText: { type: ["string", "null"] },
          },
          required: ["type", "amount", "rawText"],
        },
      },
    },
    required: ["receipt", "lines", "summaryLines"],
  };
}

async function extractReceiptFromImageBytes({ imageBytes, mimeType }) {
  const apiKey = requireEnv("ANTHROPIC_API_KEY");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const client = new Anthropic({ apiKey });

  const base64 = Buffer.from(imageBytes).toString("base64");

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: CATEGORY_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mimeType, data: base64 },
          },
          {
            type: "text",
            text: "Extract all line items and summary totals from this receipt image. Call the extract_receipt tool with the structured data.",
          },
        ],
      },
    ],
    tools: [
      {
        name: "extract_receipt",
        description: "Output structured receipt data extracted from the receipt image",
        input_schema: buildReceiptToolSchema(),
      },
    ],
    tool_choice: { type: "tool", name: "extract_receipt" },
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("Anthropic did not call the extract_receipt tool");

  console.log("Anthropic extraction done. stop_reason:", response.stop_reason);
  return toolUse.input;
}

function normalizeSummaryLines(summaryLines) {
  const base = [
    { type: "SUBTOTAL", amount: null, rawText: null },
    { type: "TAX", amount: null, rawText: null },
    { type: "TOTAL", amount: null, rawText: null },
  ];

  const map = new Map(base.map((x) => [x.type, x]));
  if (Array.isArray(summaryLines)) {
    for (const s of summaryLines) {
      if (s?.type && map.has(s.type)) {
        map.set(s.type, {
          type: s.type,
          amount: s.amount ?? null,
          rawText: s.rawText ?? null,
        });
      }
    }
  }
  return ["SUBTOTAL", "TAX", "TOTAL"].map((t) => map.get(t));
}

async function batchWriteAll(table, requests) {
  // BatchWrite max 25; also handle UnprocessedItems with retries
  for (let i = 0; i < requests.length; i += 25) {
    let chunk = requests.slice(i, i + 25);

    for (let attempt = 0; attempt < 6; attempt++) {
      const resp = await ddb.send(new BatchWriteCommand({ RequestItems: { [table]: chunk } }));
      const unprocessed = resp?.UnprocessedItems?.[table] || [];
      if (!unprocessed.length) break;

      chunk = unprocessed;
      const backoff = 200 * Math.pow(2, attempt); // 200,400,800...
      console.log(`BatchWrite unprocessed=${unprocessed.length}, retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

async function writeToReceiptLedgerTable({ receiptId, bucket, s3Key, extracted, userId }) {
  const table = requireEnv("RECEIPT_LEDGER_TABLE");
  const now = new Date().toISOString();
  const purchaseDate = resolvePurchaseDate(extracted?.receipt?.purchaseDate);

  // META row (NOT part of curation queue)
  await ddb.send(
    new PutCommand({
      TableName: table,
      Item: {
        pk: `RECEIPT#${receiptId}`,
        sk: `META#${receiptId}`,
        receiptId,
        userId,
        date: purchaseDate,
        store: extracted?.receipt?.store ?? null,
        currency: extracted?.receipt?.currency ?? "USD",
        s3Bucket: bucket,
        s3Key,
        status: "READY",
        updatedAt: now,
      },
    })
  );

  const itemLines = Array.isArray(extracted?.lines) ? extracted.lines : [];
  const summaryLines = normalizeSummaryLines(extracted?.summaryLines);

  const itemPutReqs = itemLines.map((ln, idx) => {
    const lineId = Number.isInteger(ln?.lineId) ? ln.lineId : idx + 1;
    const pk = `RECEIPT#${receiptId}`;
    const sk = `ITEM#${String(lineId).padStart(4, "0")}`;
    return {
      PutRequest: {
        Item: {
          pk,
          sk,
          receiptId,
          userId,
          date: purchaseDate,
          productCode: ln?.productCode ?? null,
          productDescription: ln?.productDescription ?? null,
          amount: ln?.amount ?? null,
          category: ln?.category ?? "Other",
          source: "scan",
          itemCount: 1,
          rawText: ln?.rawText ?? null,
          updatedAt: now,
          ...makeCurationFields({ nowIso: now, pk, sk }),
        },
      },
    };
  });

  const summaryPutReqs = summaryLines.map((s, i) => {
    const pk = `RECEIPT#${receiptId}`;
    const sk = `ITEM#9${String(i + 1).padStart(3, "0")}`; // ITEM#9001..9003
    return {
      PutRequest: {
        Item: {
          pk,
          sk,
          receiptId,
          userId,
          date: purchaseDate,
          productCode: null,
          productDescription: s.type,
          amount: s.amount ?? null,
          category: "SUMMARY",
          source: "scan",
          itemCount: 1,
          rawText: s.rawText ?? s.type,
          updatedAt: now,
          ...makeCurationFields({ nowIso: now, pk, sk }),
        },
      },
    };
  });

  const putReqs = [...itemPutReqs, ...summaryPutReqs];
  await batchWriteAll(table, putReqs);
}

async function markFailed({ receiptId, bucket, s3Key, errorMessage, userId }) {
  const table = requireEnv("RECEIPT_LEDGER_TABLE");
  const now = new Date().toISOString();

  await ddb.send(
    new PutCommand({
      TableName: table,
      Item: {
        pk: `RECEIPT#${receiptId}`,
        sk: `META#${receiptId}`,
        receiptId,
        userId: userId || null,
        s3Bucket: bucket,
        s3Key,
        status: "FAILED",
        error: String(errorMessage || "Unknown error").slice(0, 1000),
        updatedAt: now,
      },
    })
  );
}

/* -------------------- Handler -------------------- */

async function processRecord(rec) {
  const bucket = rec?.s3?.bucket?.name;
  const key = decodeS3Key(rec?.s3?.object?.key);

  if (!bucket || !key) {
    throw new Error("Bad S3 event record: missing bucket or key");
  }

  console.log("Parsed S3 bucket/key:", bucket, key);

  if (!shouldProcessKey(key)) {
    console.log(
      "SKIPPED due to prefix filter. RECEIPT_KEY_PREFIX:",
      process.env.RECEIPT_KEY_PREFIX ?? "receipts/"
    );
    return { ok: true, skipped: true, bucket, key };
  }

  const uniqueId = buildUniqueIdFromS3(bucket, key);
  let receiptId = `S3-${uniqueId}`; // provisional
  console.log("provisional receiptId:", receiptId);

  const userId = await resolveUserIdFromS3({ bucket, key });
  console.log("Resolved userId:", userId || "(missing)");

  try {
    console.log("Calling S3 GetObject...");
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    console.log("S3 ContentType:", obj.ContentType);

    const bytes = await streamToBuffer(obj.Body);
    console.log("Downloaded bytes:", bytes.length);

    const mimeType = guessMimeType(obj.ContentType, key);
    console.log("Guessed mimeType:", mimeType);

    if (mimeType === "application/pdf" || key.toLowerCase().endsWith(".pdf")) {
      throw new Error("PDF uploaded but PDF-to-image is not implemented. Upload an image for now.");
    }
    if (!mimeType.startsWith("image/")) {
      throw new Error(`Unsupported content type: ${mimeType}. Expected image/*`);
    }

    console.log("Calling Anthropic...");
    const extracted = await extractReceiptFromImageBytes({ imageBytes: bytes, mimeType });
    console.log("Anthropic extraction done. Lines:", Array.isArray(extracted.lines) ? extracted.lines.length : 0);

    const store = extracted?.receipt?.store ?? null;
    const purchaseDate = resolvePurchaseDate(extracted?.receipt?.purchaseDate);

    receiptId = buildReceiptId({ store, purchaseDate, uniqueId });
    if (!isYYYYMMDD(extracted?.receipt?.purchaseDate)) {
      console.log("Anthropic did not return a valid purchaseDate. Using current date fallback.");
    }
    console.log("final receiptId:", receiptId);

    console.log("Writing to DynamoDB table:", process.env.RECEIPT_LEDGER_TABLE);
    await writeToReceiptLedgerTable({ receiptId, bucket, s3Key: key, extracted, userId });

    console.log("DynamoDB write complete.");
    return { ok: true, receiptId, bucket, key, userId, lines: (extracted?.lines?.length || 0) + 3 };
  } catch (err) {
    console.error("FAILED:", err);
    await markFailed({
      receiptId,
      bucket,
      s3Key: key,
      errorMessage: err?.stack || String(err),
      userId,
    });
    throw err;
  }
}

export const handler = async (event) => {
  console.log("EVENT:", JSON.stringify(event));

  const records = Array.isArray(event?.Records) ? event.Records : [];
  if (!records.length) {
    throw new Error("This Lambda is S3-triggered only. Expected an S3 ObjectCreated event.");
  }

  // Process all records sequentially
  const results = [];
  for (const rec of records) {
    results.push(await processRecord(rec));
  }

  return { ok: true, results };
};
