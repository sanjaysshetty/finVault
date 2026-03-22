/**
 * Backfill country="USA" on all existing STOCK_TX, CRYPTO_TX, BULLION_TX,
 * FUTURES_TX, and OPTIONS_TX records that are missing the country field.
 *
 * Usage:
 *   AWS_PROFILE=finvault-dev node backfill-country.mjs
 *
 * Safe to run multiple times — only updates items missing the country field.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { fromIni } from "@aws-sdk/credential-providers";

const REGION = process.env.AWS_REGION || "us-east-1";
const PROFILE = process.env.AWS_PROFILE || "finvault-dev";
const TABLE = "finAssets";
const TARGET_TYPES = new Set(["STOCK_TX", "CRYPTO_TX", "BULLION_TX", "FUTURES_TX", "OPTIONS_TX"]);

const client = new DynamoDBClient({
  region: REGION,
  credentials: fromIni({ profile: PROFILE }),
});
const ddb = DynamoDBDocumentClient.from(client);

async function scanAll() {
  const items = [];
  let lastKey;
  do {
    const resp = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: "attribute_exists(assetType)",
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(resp.Items || []));
    lastKey = resp.LastEvaluatedKey;
    console.log(`Scanned ${items.length} items so far…`);
  } while (lastKey);
  return items;
}

async function run() {
  console.log(`Connecting with profile: ${PROFILE}`);
  const all = await scanAll();

  const toUpdate = all.filter(
    (item) => TARGET_TYPES.has(item.assetType) && !item.country
  );

  console.log(`Found ${toUpdate.length} items to backfill (out of ${all.length} total).`);

  let done = 0;
  for (const item of toUpdate) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { userId: item.userId, assetId: item.assetId },
      UpdateExpression: "SET #c = :c",
      ExpressionAttributeNames: { "#c": "country" },
      ExpressionAttributeValues: { ":c": "USA" },
      ConditionExpression: "attribute_not_exists(#c)",
    }));
    done++;
    if (done % 50 === 0) console.log(`Updated ${done}/${toUpdate.length}…`);
  }

  console.log(`Done. Updated ${done} items.`);
}

run().catch((err) => { console.error(err); process.exit(1); });
