/**
 * finassets-backfill-gsi1pk.js
 *
 * For finAssets items of a specific userId (PK),
 * ensure gsi1pk equals that same userId.
 *
 * This fixes list queries that rely on GSI1.
 *
 * Usage:
 *   PROFILE=finvault-sb AWS_REGION=us-east-1 \
 *   TABLE=finAssets \
 *   USER_ID=d4c8d4c8-40f1-704f-4fbe-7fd97fec4688 \
 *   node finassets-backfill-gsi1pk.js
 */

const { DynamoDBClient, DescribeTableCommand } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { fromIni } = require("@aws-sdk/credential-providers");

const REGION = process.env.AWS_REGION || "us-east-1";
const PROFILE = process.env.PROFILE || "";
const TABLE = process.env.TABLE || "finAssets";
const USER_ID = process.env.USER_ID;

if (!USER_ID) {
  console.error("Missing USER_ID env var");
  process.exit(1);
}

console.log("Region:", REGION);
console.log("Profile:", PROFILE || "(default)");
console.log("Table:", TABLE);
console.log("USER_ID:", USER_ID);

const ddb = new DynamoDBClient({
  region: REGION,
  credentials: PROFILE ? fromIni({ profile: PROFILE }) : undefined,
});
const doc = DynamoDBDocumentClient.from(ddb, {
  marshallOptions: { removeUndefinedValues: true },
});

const BATCH_MAX = 25;
const MAX_RETRIES = 10;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function backoffMs(attempt) {
  const base = Math.min(2000, 100 * Math.pow(2, attempt));
  return base + Math.floor(Math.random() * 100);
}

async function batchWriteWithRetry(RequestItems) {
  let req = RequestItems;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await doc.send(new BatchWriteCommand({ RequestItems: req }));
    const up = resp.UnprocessedItems || {};
    const remaining = Object.keys(up).reduce((n, t) => n + (up[t]?.length || 0), 0);
    if (remaining === 0) return;

    const wait = backoffMs(attempt);
    console.log(`  Unprocessed items: ${remaining}. Retry in ${wait}ms`);
    await sleep(wait);
    req = up;
  }
  throw new Error("BatchWrite still had UnprocessedItems after retries.");
}

async function main() {
  // Detect key schema
  const desc = await ddb.send(new DescribeTableCommand({ TableName: TABLE }));
  const ks = desc.Table?.KeySchema || [];
  const pk = ks.find((k) => k.KeyType === "HASH")?.AttributeName;
  const sk = ks.find((k) => k.KeyType === "RANGE")?.AttributeName;
  if (!pk) throw new Error("Could not detect partition key");

  console.log(`Key schema: PK=${pk}${sk ? `, SK=${sk}` : ""}`);

  // Query all items by PK (much faster than Scan)
  let lastKey = undefined;
  let updated = 0;
  let seen = 0;

  while (true) {
    const resp = await doc.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "#pk = :u",
        ExpressionAttributeNames: { "#pk": pk },
        ExpressionAttributeValues: { ":u": USER_ID },
        ExclusiveStartKey: lastKey,
      })
    );

    const items = resp.Items || [];
    seen += items.length;

    // Build PutRequests only for items needing change
    const puts = [];
    for (const it of items) {
      if (it.gsi1pk === USER_ID) continue; // already correct
      const newItem = { ...it, gsi1pk: USER_ID };
      puts.push({ PutRequest: { Item: newItem } });
    }

    // BatchWrite in chunks of 25
    for (let i = 0; i < puts.length; i += BATCH_MAX) {
      const batch = puts.slice(i, i + BATCH_MAX);
      await batchWriteWithRetry({ [TABLE]: batch });
      updated += batch.length;
      console.log(`  updated ${updated} items so far...`);
    }

    lastKey = resp.LastEvaluatedKey;
    if (!lastKey) break;
  }

  console.log(`Done. Items read: ${seen}. Items updated: ${updated}.`);
}

main().catch((e) => {
  console.error("Failed:", e);
  process.exit(1);
});