// curate-incremental.mjs
import {
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { createRequire } from "module";

// Node's native ESM `import` cannot resolve Lambda Layer content via
// NODE_PATH — only CommonJS `require` can. createRequire bridges into that
// NODE_PATH-aware resolution from this ESM file. Confirmed empirically:
// without this, every invocation fails with ERR_MODULE_NOT_FOUND.
const require = createRequire(import.meta.url);
const { doc: ddb } = require("finvault-shared/db/client");

/**
 * Incremental curation Lambda:
 * - Fetches ONLY items that have needsCuration = true (via Scan + FilterExpression)
 * - Classifies category via the consolidated CategorizationFunction (Python,
 *   StructuredCall) — NOT an inline Claude call anymore. This Lambda used to
 *   run its own independent taxonomy; it's now one of two callers of the
 *   single shared categorization service (the other being spending-api's
 *   on-demand /spending/categorize route), closing the "needsCuration churn"
 *   where items got reclassified against 2-3 different, drifted taxonomies
 *   before settling on whichever ran last.
 * - Updates item with category + sets needsCuration=false
 * - Uses ConditionExpression to be idempotent and race-safe
 */

const REGION =
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const TABLE = process.env.TABLE || "StoreReceiptLedger";
const CATEGORIZATION_FUNCTION = process.env.CATEGORIZATION_FUNCTION || "";

// Scan page size — also the batch size handed to the categorization
// service in one invoke; it internally sub-chunks into its own smaller
// Claude-call batches, so this Lambda doesn't need to chunk itself.
const SCAN_LIMIT = Number(process.env.SCAN_LIMIT || "200");

// Optional: cap number of processed items per run (useful while testing)
const MAX_ITEMS = process.env.MAX_ITEMS ? Number(process.env.MAX_ITEMS) : null;

// Stop early before timeout (ms). Default: 30s buffer.
const STOP_BUFFER_MS = Number(process.env.STOP_BUFFER_MS || "30000");

const lambda = new LambdaClient({});

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
  const store =
    pickField(item, ["storeName", "merchant", "merchantName", "retailer", "vendor"]) || "";

  const desc =
    pickField(item, ["productDescription", "description", "itemDescription", "name", "title"]) || "";

  const code =
    pickField(item, ["productCode", "upc", "sku", "itemCode", "plu"]) || "";

  return {
    storeName: String(store).slice(0, 80),
    productDescription: String(desc).slice(0, 200),
    productCode: String(code).slice(0, 60),
  };
}

/** One RequestResponse invoke of the shared categorization service.
 * Returns a list of {category, confidence} in the same order as `items`. */
async function categorizeBatch(items) {
  if (!CATEGORIZATION_FUNCTION) {
    throw new Error("CATEGORIZATION_FUNCTION env var not configured");
  }
  const resp = await lambda.send(
    new InvokeCommand({
      FunctionName: CATEGORIZATION_FUNCTION,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ items: items.map(normalizeItemForModel) })),
    })
  );
  const payload = JSON.parse(Buffer.from(resp.Payload).toString("utf-8"));
  if (!payload.ok) {
    throw new Error(`Categorization service failed: ${payload.error}`);
  }
  return payload.categorizations;
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
    CATEGORIZATION_FUNCTION,
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

    const validItems = items.filter((it) => it.pk && it.sk && it.needsCuration === true);
    skipped += items.length - validItems.length;

    if (validItems.length > 0) {
      try {
        processed += validItems.length;
        const categorizations = await categorizeBatch(validItems);

        for (let i = 0; i < validItems.length; i++) {
          const it = validItems[i];
          const { category } = categorizations[i] || {};
          if (!category) {
            failed += 1;
            console.error(`No category returned for pk=${it.pk} sk=${it.sk}`);
            continue;
          }
          try {
            await updateItemIfStillNeedsCuration({ pk: it.pk, sk: it.sk }, category);
            updated += 1;
          } catch (e) {
            const msg = String(e?.message || e);
            // Conditional check fails are okay (means it got curated elsewhere)
            if (msg.includes("ConditionalCheckFailed")) {
              skipped += 1;
            } else {
              failed += 1;
              console.error(`FAILED update pk=${it.pk} sk=${it.sk} :: ${msg.slice(0, 300)}`);
            }
          }
        }
      } catch (e) {
        // Whole-batch failure (e.g. categorization service down) -- don't
        // update anything from this page; these items stay needsCuration=true
        // and get retried on the next scheduled run.
        failed += validItems.length;
        console.error(`Batch categorization failed: ${String(e?.message || e).slice(0, 300)}`);
      }
    }

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
