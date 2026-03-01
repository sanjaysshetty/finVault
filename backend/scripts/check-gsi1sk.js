/**
 * Show all distinct gsi1sk prefixes in finAssets for a given userId.
 * Usage:
 *   PROFILE=finvault-dev AWS_REGION=us-east-1 \
 *   TABLE=finAssets \
 *   USER_ID=54586468-40a1-704e-3125-ccae79f4fc79 \
 *   node check-gsi1sk.js
 */
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { fromIni } = require("@aws-sdk/credential-providers");

const REGION = process.env.AWS_REGION || "us-east-1";
const PROFILE = process.env.PROFILE || "";
const TABLE = process.env.TABLE || "finAssets";
const USER_ID = process.env.USER_ID;

if (!USER_ID) { console.error("Missing USER_ID"); process.exit(1); }

const ddb = new DynamoDBClient({ region: REGION, credentials: PROFILE ? fromIni({ profile: PROFILE }) : undefined });
const doc = DynamoDBDocumentClient.from(ddb);

async function main() {
  const prefixCounts = {};
  let lastKey;
  let total = 0;

  do {
    const resp = await doc.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "userId = :u",
      ExpressionAttributeValues: { ":u": USER_ID },
      ExclusiveStartKey: lastKey,
    }));

    for (const item of resp.Items || []) {
      total++;
      const sk = item.gsi1sk || "(no gsi1sk)";
      // extract prefix = everything up to and including the first #
      const prefix = sk.includes("#") ? sk.slice(0, sk.indexOf("#") + 1) : sk;
      prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
    }
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  console.log(`\nTotal items: ${total}`);
  console.log("\ngsi1sk prefixes found:");
  for (const [prefix, count] of Object.entries(prefixCounts).sort()) {
    console.log(`  ${prefix.padEnd(25)} ${count} items`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
