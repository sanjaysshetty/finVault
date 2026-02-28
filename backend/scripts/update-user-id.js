/**
 * Update userId across DynamoDB tables in ONE account/profile.
 *
 * finAssets (PK=userId, SK=assetId): userId is key -> must MOVE items (Put new + Delete old)
 * StoreReceiptLedger: usually userId is NOT key -> overwrite (Put) with updated userId
 *
 * Usage:
 *   PROFILE=finvault-sb AWS_REGION=us-east-1 \
 *   OLD_USER_ID=5458... NEW_USER_ID=d4c8... \
 *   node update-user-id.js
 */

const { DynamoDBClient, DescribeTableCommand } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  BatchWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { fromIni } = require("@aws-sdk/credential-providers");

// ---------- CONFIG ----------
const REGION = process.env.AWS_REGION || "us-east-1";
const PROFILE = process.env.PROFILE || "default";

const FIN_ASSETS_TABLE = process.env.FIN_ASSETS_TABLE || "finAssets";
const LEDGER_TABLE = process.env.LEDGER_TABLE || "StoreReceiptLedger";

const NEW_USER_ID = process.env.NEW_USER_ID || "d4c8d4c8-40f1-704f-4fbe-7fd97fec4688";
const OLD_USER_ID = process.env.OLD_USER_ID || "";

// BatchWrite hard limit
const BATCH_MAX = 25;

// Safe limits:
// - MOVE uses 2 ops per item -> keep it <= 24 ops => 12 items per batch
const MOVE_OP_LIMIT = 24;
// - PUT-only can use full 25
const PUT_OP_LIMIT = 25;

const MAX_RETRIES = 12;
// --------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function backoffMs(attempt) {
  const base = Math.min(10_000, 200 * Math.pow(2, attempt));
  return base + Math.floor(Math.random() * 200);
}

function makeClients() {
  const ddb = new DynamoDBClient({
    region: REGION,
    credentials: fromIni({ profile: PROFILE }),
  });
  const doc = DynamoDBDocumentClient.from(ddb, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return { ddb, doc };
}

async function describeKeys(ddb, tableName) {
  const resp = await ddb.send(new DescribeTableCommand({ TableName: tableName }));
  const ks = resp?.Table?.KeySchema || [];
  const pk = ks.find((k) => k.KeyType === "HASH")?.AttributeName;
  const sk = ks.find((k) => k.KeyType === "RANGE")?.AttributeName || null;
  if (!pk) throw new Error(`Could not determine partition key for table ${tableName}`);
  return { pk, sk };
}

async function* scanAll(doc, tableName) {
  let ExclusiveStartKey = undefined;
  do {
    const resp = await doc.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey,
      })
    );
    for (const item of resp.Items || []) yield item;
    ExclusiveStartKey = resp.LastEvaluatedKey;
  } while (ExclusiveStartKey);
}

function buildKey(item, pk, sk) {
  if (!(pk in item)) throw new Error(`Item missing partition key attr "${pk}"`);
  const Key = { [pk]: item[pk] };
  if (sk) {
    if (!(sk in item)) throw new Error(`Item missing sort key attr "${sk}"`);
    Key[sk] = item[sk];
  }
  return Key;
}

function shouldTouch(item) {
  if (!item || typeof item !== "object") return false;
  if (!("userId" in item)) return false;
  if (OLD_USER_ID) return item.userId === OLD_USER_ID;
  return true;
}

async function batchWriteWithRetry(doc, tableName, ops) {
  if (!ops.length) return;
  if (ops.length > BATCH_MAX) {
    throw new Error(`Internal error: attempted to write ${ops.length} ops (max ${BATCH_MAX})`);
  }

  let RequestItems = { [tableName]: ops };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await doc.send(new BatchWriteCommand({ RequestItems }));
    const up = resp.UnprocessedItems || {};
    const remaining = up[tableName] || [];

    if (!remaining.length) return;

    RequestItems = { [tableName]: remaining };
    await sleep(backoffMs(attempt));
  }

  throw new Error(`BatchWrite still has unprocessed items after ${MAX_RETRIES} retries for ${tableName}`);
}

async function processTable(doc, ddb, tableName) {
  const { pk, sk } = await describeKeys(ddb, tableName);
  const userIdIsKey = pk === "userId" || sk === "userId";
  const opLimit = userIdIsKey ? MOVE_OP_LIMIT : PUT_OP_LIMIT;

  console.log(`\nTable: ${tableName}`);
  console.log(`  Key schema: PK=${pk}${sk ? `, SK=${sk}` : ""}`);
  console.log(`  Mode: ${userIdIsKey ? "MOVE (Put+Delete)" : "PUT (overwrite)"} | batch op limit: ${opLimit}`);

  let scanned = 0;
  let touched = 0;
  let writtenOps = 0;

  let ops = [];

  async function flush() {
    if (!ops.length) return;
    await batchWriteWithRetry(doc, tableName, ops);
    writtenOps += ops.length;
    ops = [];
  }

  for await (const item of scanAll(doc, tableName)) {
    scanned++;

    if (!shouldTouch(item)) continue;
    if (item.userId === NEW_USER_ID) continue;

    touched++;

    if (userIdIsKey) {
      // MOVE: Put new + Delete old
      const oldKey = buildKey(item, pk, sk);
      const newItem = { ...item, userId: NEW_USER_ID };

      // If adding 2 ops would exceed limit, flush first
      if (ops.length + 2 > opLimit) await flush();

      ops.push({ PutRequest: { Item: newItem } });
      ops.push({ DeleteRequest: { Key: oldKey } });
    } else {
      // PUT overwrite
      const newItem = { ...item, userId: NEW_USER_ID };

      if (ops.length + 1 > opLimit) await flush();

      ops.push({ PutRequest: { Item: newItem } });
    }
  }

  await flush();

  console.log(`  scanned: ${scanned}`);
  console.log(`  updated/moved items: ${touched}`);
  console.log(`  total write ops sent: ${writtenOps}`);
}

async function main() {
  if (!NEW_USER_ID) throw new Error("NEW_USER_ID is required");

  console.log("Region:", REGION);
  console.log("Profile:", PROFILE);
  console.log("NEW_USER_ID:", NEW_USER_ID);
  console.log("OLD_USER_ID:", OLD_USER_ID || "(not set; would update ALL items with userId)");

  const { ddb, doc } = makeClients();

  await processTable(doc, ddb, FIN_ASSETS_TABLE);
  await processTable(doc, ddb, LEDGER_TABLE);

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Failed:", e);
  process.exit(1);
});