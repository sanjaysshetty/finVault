// curate-incremental.mjs
import OpenAI from "openai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import pLimit from "p-limit";

/**
 * Incremental curation Lambda:
 * - Fetches ONLY items that have needsCuration = true (via Scan + FilterExpression)
 * - Classifies category using OpenAI
 * - Updates item with category + sets needsCuration=false
 * - Uses ConditionExpression to be idempotent and race-safe
 */

const REGION =
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const TABLE = process.env.TABLE || "StoreReceiptLedger";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY env var");

// Model: pick one you have access to
const MODEL = process.env.MODEL || "gpt-5.2";

// Concurrency (keep modest to avoid DynamoDB throttling + API bursts)
const CONCURRENCY = Number(process.env.CONCURRENCY || "5");

// Scan page size
const SCAN_LIMIT = Number(process.env.SCAN_LIMIT || "200");

// Optional: cap number of processed items per run (useful while testing)
const MAX_ITEMS = process.env.MAX_ITEMS ? Number(process.env.MAX_ITEMS) : null;

// Stop early before timeout (ms). Default: 30s buffer.
const STOP_BUFFER_MS = Number(process.env.STOP_BUFFER_MS || "30000");

const CATEGORIES = [
  "Groceries",
  "Dining & Takeout",
  "Household Supplies",
  "Personal Care",
  "Clothing & Footwear",
  "Home & Furniture",
  "Health & Pharmacy",
  "Electronics & Gadgets",
  "Transportation & Auto",
  "Miscellaneous / Other",
];

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const limit = pLimit(CONCURRENCY);

function nowIso() {
  return new Date().toISOString();
}

function pickField(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && String(obj[k]).trim() !== "") return obj[k];
  }
  return null;
}

function normalizeItemForModel(item) {
  const pk = item.pk;
  const sk = item.sk;

  const store =
    pickField(item, ["storeName", "merchant", "merchantName", "retailer", "vendor"]) || "";

  const desc =
    pickField(item, ["productDescription", "description", "itemDescription", "name", "title"]) || "";

  const code =
    pickField(item, ["productCode", "upc", "sku", "itemCode", "plu"]) || "";

  return {
    pk,
    sk,
    storeName: String(store).slice(0, 80),
    productDescription: String(desc).slice(0, 200),
    productCode: String(code).slice(0, 60),
  };
}

function buildInstructions() {
  return `
You are categorizing store receipt LINE ITEMS into exactly one of the following categories:

${CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Rules:
- Choose exactly ONE category from the list (must match spelling exactly).
- Use productDescription primarily. Use storeName and productCode only as tie-breakers.
- If description is vague (e.g., "item", "misc", "fee") choose "Miscellaneous / Other".
- Food you bring home -> "Groceries".
- Prepared food/drinks consumed outside home -> "Dining & Takeout".
- Paper goods, detergents, trash bags, cleaning -> "Household Supplies".
- Shampoo, toothpaste, deodorant, cosmetics, vitamins -> "Personal Care".
- Apparel/shoes -> "Clothing & Footwear".
- Durable home goods, cookware, bins, small appliances -> "Home & Furniture".
- Prescriptions, OTC meds, first aid -> "Health & Pharmacy".
- Chargers, cables, devices, batteries -> "Electronics & Gadgets".
- Gas, motor oil, car wash, accessories -> "Transportation & Auto".

Output format:
Return ONLY valid JSON with this schema:
{
  "category": "<one of the 10 categories>",
  "confidence": 0-1,
  "reason": "<short, 1 sentence>"
}
`.trim();
}

async function classifyOne(item) {
  const payload = normalizeItemForModel(item);

  const res = await client.responses.create({
    model: MODEL,
    instructions: buildInstructions(),
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: JSON.stringify(payload) }],
      },
    ],
    temperature: 0.2,
  });

  const text = res.output_text;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Recover minimal JSON if model outputs extra text
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Non-JSON model output: ${text.slice(0, 200)}`);
    json = JSON.parse(match[0]);
  }

  const category = json.category;
  if (!CATEGORIES.includes(category)) {
    throw new Error(`Invalid category '${category}' pk=${item.pk} sk=${item.sk}`);
  }

  return {
    category,
    confidence: json.confidence ?? null,
    reason: json.reason ?? null,
  };
}

/**
 * Idempotent update:
 * - Only updates if needsCuration is still true at write time
 * - Prevents overwriting items that might have been curated elsewhere
 */
async function updateItemIfStillNeedsCuration({ pk, sk }, category) {
  const updatedAt = nowIso();
  const curationSort = `CURATED#${updatedAt}#${pk}#${sk}`;

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk, sk },

      // Only update items that still need curation (race-safe)
      ConditionExpression:
        "attribute_exists(pk) AND attribute_exists(sk) AND needsCuration = :t",

      UpdateExpression:
        "SET #cat = :cat, needsCuration = :f, curationKey = :ck, curationSort = :cs, updatedAt = :ua",

      ExpressionAttributeNames: { "#cat": "category" },
      ExpressionAttributeValues: {
        ":cat": category,
        ":t": true,
        ":f": false,
        ":ck": "CURATION",
        ":cs": curationSort,
        ":ua": updatedAt,
      },
    })
  );
}

/**
 * Incremental fetch:
 * Scan + FilterExpression on needsCuration=true.
 * (Upgrade path: replace Scan with Query on a GSI to avoid scanning.)
 */
async function scanNeedsCurationPage(exclusiveStartKey) {
  return ddb.send(
    new ScanCommand({
      TableName: TABLE,
      ExclusiveStartKey: exclusiveStartKey,
      Limit: SCAN_LIMIT,

      FilterExpression: "needsCuration = :t",
      ExpressionAttributeValues: { ":t": true },

      // Alias reserved keywords (e.g., "name") and any other potentially reserved attrs
      ExpressionAttributeNames: {
        "#nm": "name",
        "#desc": "description",
        "#ttl": "title",
      },

      // Keep payload minimal to reduce DynamoDB read + Lambda memory
      ProjectionExpression:
        "pk, sk, needsCuration, " +
        "storeName, merchant, merchantName, retailer, vendor, " +
        "productDescription, #desc, itemDescription, #nm, #ttl, " +
        "productCode, upc, sku, itemCode, plu",
    })
  );
}

export const handler = async (event, context) => {
  console.log("Incremental curation batch starting", {
    REGION,
    TABLE,
    MODEL,
    CONCURRENCY,
    SCAN_LIMIT,
    MAX_ITEMS,
    requestId: context?.awsRequestId,
  });

  let scanned = 0;
  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  let ExclusiveStartKey = undefined;

  // Stop ~buffer ms before timeout so Lambda exits cleanly
  const stopAt = Date.now() + Math.max(0, context.getRemainingTimeInMillis() - STOP_BUFFER_MS);

  while (Date.now() < stopAt) {
    const resp = await scanNeedsCurationPage(ExclusiveStartKey);
    const items = resp.Items || [];

    scanned += items.length;

    if (items.length === 0 && !resp.LastEvaluatedKey) {
      // No more pages and nothing returned
      break;
    }

    const tasks = items.map((it) =>
      limit(async () => {
        if (!it.pk || !it.sk) {
          skipped += 1;
          return;
        }

        // Since we scanned w/ filter, this is usually true, but keep it safe
        if (it.needsCuration !== true) {
          skipped += 1;
          return;
        }

        try {
          processed += 1;

          const { category } = await classifyOne(it);

          // Conditional update ensures we only update if still needsCuration=true
          await updateItemIfStillNeedsCuration({ pk: it.pk, sk: it.sk }, category);

          updated += 1;
        } catch (e) {
          failed += 1;
          const msg = String(e?.message || e);
          // Conditional check fails are okay (means it got curated elsewhere)
          if (msg.includes("ConditionalCheckFailed")) {
            skipped += 1;
            return;
          }
          console.error(`FAILED pk=${it.pk} sk=${it.sk} :: ${msg.slice(0, 300)}`);
        }
      })
    );

    await Promise.all(tasks);

    console.log("Progress", { scanned, processed, updated, skipped, failed });

    if (MAX_ITEMS && processed >= MAX_ITEMS) {
      console.log(`Stopping early due to MAX_ITEMS=${MAX_ITEMS}`);
      break;
    }

    ExclusiveStartKey = resp.LastEvaluatedKey;
    if (!ExclusiveStartKey) break; // finished scan
  }

  const result = { scanned, processed, updated, skipped, failed };
  console.log("DONE ✅", result);
  return result;
};
