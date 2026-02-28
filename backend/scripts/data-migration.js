/**
 * DynamoDB migration: finvault-dev -> finvault-sb
 * Copies all items from finAssets and StoreReceiptLedger.
 *
 * Usage:
 *   OLD_PROFILE=finvault-dev NEW_PROFILE=finvault-sb node data-migration.js
 *
 * Optional:
 *   AWS_REGION=us-east-1
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  BatchWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { fromIni } = require("@aws-sdk/credential-providers");

// ---------- CONFIG ----------
const REGION = process.env.AWS_REGION || "us-east-1";
const OLD_PROFILE = process.env.OLD_PROFILE || "finvault-dev";
const NEW_PROFILE = process.env.NEW_PROFILE || "finvault-sb";

const TABLES = [
  { source: "finAssets", target: "finAssets" },
  { source: "StoreReceiptLedger", target: "StoreReceiptLedger" },
];

// Optional userId rewrite (only if needed)
const USER_ID_MAP = {
  // "old-user-id-guid": "new-user-id-guid",
};

const BATCH_SIZE = 25;
const MAX_RETRIES = 12;
// --------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt) {
  const base = Math.min(10_000, 200 * Math.pow(2, attempt));
  return base + Math.floor(Math.random() * 200);
}

function rewriteItem(item) {
  if (!item || typeof item !== "object") return item;
  if (item.userId && USER_ID_MAP[item.userId]) {
    return { ...item, userId: USER_ID_MAP[item.userId] };
  }
  return item;
}

function makeDocClient(profile) {
  const ddb = new DynamoDBClient({
    region: REGION,
    credentials: fromIni({ profile }),
  });
  return DynamoDBDocumentClient.from(ddb, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

async function* scanAll(docClient, tableName) {
  let ExclusiveStartKey = undefined;
  let scanned = 0;

  do {
    const resp = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey,
      })
    );

    const items = resp.Items || [];
    scanned += items.length;

    for (const it of items) yield it;

    ExclusiveStartKey = resp.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  // Helpful: log scanned count when finished
  console.log(`  scanned ${scanned} items from ${tableName}`);
}

async function batchWriteWithRetry(docClient, RequestItems) {
  let unprocessed = RequestItems;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await docClient.send(new BatchWriteCommand({ RequestItems: unprocessed }));

    const up = resp.UnprocessedItems || {};
    const hasUnprocessed =
      Object.keys(up).length > 0 &&
      Object.values(up).some((arr) => Array.isArray(arr) && arr.length > 0);

    if (!hasUnprocessed) return;

    unprocessed = up;
    await sleep(backoffMs(attempt));
  }

  throw new Error(`BatchWrite still has unprocessed items after ${MAX_RETRIES} retries`);
}

async function copyTable(srcDoc, dstDoc, sourceTable, targetTable) {
  console.log(`\nCopying ${sourceTable} -> ${targetTable}`);

  let buffer = [];
  let total = 0;

  async function flush() {
    if (buffer.length === 0) return;

    const puts = buffer.map((Item) => ({ PutRequest: { Item } }));
    await batchWriteWithRetry(dstDoc, { [targetTable]: puts });

    total += buffer.length;
    console.log(`  wrote ${total} items...`);
    buffer = [];
  }

  for await (const item of scanAll(srcDoc, sourceTable)) {
    buffer.push(rewriteItem(item));
    if (buffer.length >= BATCH_SIZE) await flush();
  }

  await flush();
  console.log(`Done. Total copied for ${sourceTable}: ${total}`);
}

async function main() {
  console.log("Region:", REGION);
  console.log("Old profile:", OLD_PROFILE);
  console.log("New profile:", NEW_PROFILE);

  const srcDoc = makeDocClient(OLD_PROFILE);
  const dstDoc = makeDocClient(NEW_PROFILE);

  for (const t of TABLES) {
    await copyTable(srcDoc, dstDoc, t.source, t.target);
  }

  console.log("\nMigration complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});