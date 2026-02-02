// curate-all.mjs
import OpenAI from "openai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import pLimit from "p-limit";

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const TABLE = process.env.TABLE || "StoreReceiptLedger";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY env var");

// Model: pick one you have access to
const MODEL = process.env.MODEL || "gpt-4.1-mini";

// Only curate items that currently need curation?
const ONLY_NEEDS_CURATION = (process.env.ONLY_NEEDS_CURATION || "true") === "true";

// Concurrency (keep modest to avoid DynamoDB throttling + API bursts)
const CONCURRENCY = Number(process.env.CONCURRENCY || "5");

// Scan page size
const SCAN_LIMIT = Number(process.env.SCAN_LIMIT || "200");

// Optional: stop after N items (for testing)
const MAX_ITEMS = process.env.MAX_ITEMS ? Number(process.env.MAX_ITEMS) : null;

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
    pk, sk,
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
        content: [
          {
            type: "input_text",
            text: JSON.stringify(payload),
          },
        ],
      },
    ],
    // keep it deterministic-ish
    temperature: 0.2,
  });

  // Extract text output
  const text = res.output_text;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // If model returned extra text, try to recover minimal JSON
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Non-JSON model output: ${text.slice(0, 200)}`);
    json = JSON.parse(match[0]);
  }

  const category = json.category;
  if (!CATEGORIES.includes(category)) {
    throw new Error(`Invalid category '${category}' for item pk=${item.pk} sk=${item.sk}`);
  }

  return { category, confidence: json.confidence ?? null, reason: json.reason ?? null };
}

async function updateItem({ pk, sk }, category) {
  const updatedAt = nowIso();
  const curationSort = `CURATED#${updatedAt}#${pk}#${sk}`;

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk, sk },
      UpdateExpression:
        "SET #cat = :cat, needsCuration = :nc, curationKey = :ck, curationSort = :cs, updatedAt = :ua",
      ExpressionAttributeNames: {
        "#cat": "category",
      },
      ExpressionAttributeValues: {
        ":cat": category,
        ":nc": false,
        ":ck": "CURATION",
        ":cs": curationSort,
        ":ua": updatedAt,
      },
    })
  );
}

async function main() {
  console.log(`Region=${REGION}`);
  console.log(`TABLE=${TABLE}`);
  console.log(`MODEL=${MODEL}`);
  console.log(`ONLY_NEEDS_CURATION=${ONLY_NEEDS_CURATION}`);
  console.log(`CONCURRENCY=${CONCURRENCY}`);
  console.log(`SCAN_LIMIT=${SCAN_LIMIT}`);

  let scanned = 0;
  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  let ExclusiveStartKey = undefined;

  while (true) {
    const resp = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        ExclusiveStartKey,
        Limit: SCAN_LIMIT,
      })
    );

    const items = resp.Items || [];
    scanned += items.length;

    const tasks = items.map((it) =>
      limit(async () => {
        // basic key check
        if (!it.pk || !it.sk) {
          skipped += 1;
          return;
        }

        if (ONLY_NEEDS_CURATION && it.needsCuration === false) {
          skipped += 1;
          return;
        }

        try {
          processed += 1;
          const { category } = await classifyOne(it);
          await updateItem({ pk: it.pk, sk: it.sk }, category);
          updated += 1;
        } catch (e) {
          failed += 1;
          console.error(
            `FAILED pk=${it.pk} sk=${it.sk} :: ${String(e?.message || e).slice(0, 300)}`
          );
        }
      })
    );

    await Promise.all(tasks);

    console.log(
      `Progress: scanned=${scanned}, processed=${processed}, updated=${updated}, skipped=${skipped}, failed=${failed}`
    );

    if (MAX_ITEMS && processed >= MAX_ITEMS) {
      console.log(`Stopping early due to MAX_ITEMS=${MAX_ITEMS}`);
      break;
    }

    ExclusiveStartKey = resp.LastEvaluatedKey;
    if (!ExclusiveStartKey) break;
  }

  console.log("DONE ✅");
  console.log({ scanned, processed, updated, skipped, failed });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
