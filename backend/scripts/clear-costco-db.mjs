import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const TABLE_NAME = process.env.TABLE_NAME || "CostcoSpending";

const client = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(client);

async function batchDelete(keys) {
  if (!keys.length) return;

  // DynamoDB batchWrite limit = 25
  for (let i = 0; i < keys.length; i += 25) {
    const chunk = keys.slice(i, i + 25);

    let unprocessed = {
      [TABLE_NAME]: chunk.map((Key) => ({ DeleteRequest: { Key } })),
    };

    let attempts = 0;
    while (unprocessed[TABLE_NAME]?.length && attempts < 8) {
      attempts += 1;

      const resp = await ddb.send(
        new BatchWriteCommand({
          RequestItems: unprocessed,
        })
      );

      const up = resp.UnprocessedItems?.[TABLE_NAME] || [];
      if (!up.length) {
        unprocessed = {};
        break;
      }

      // exponential backoff
      const delay = Math.min(250 * 2 ** (attempts - 1), 4000);
      await new Promise((r) => setTimeout(r, delay));

      unprocessed = { [TABLE_NAME]: up };
    }

    if (unprocessed[TABLE_NAME]?.length) {
      throw new Error(`Failed to delete some items after retries: ${unprocessed[TABLE_NAME].length}`);
    }
  }
}

async function main() {
  console.log(`Clearing table ${TABLE_NAME} in ${REGION}...`);

  let total = 0;
  let lastKey = undefined;

  while (true) {
    const resp = await ddb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        ProjectionExpression: "pk, sk",
        ExclusiveStartKey: lastKey,
      })
    );

    const items = resp.Items || [];
    if (items.length) {
      const keys = items.map((it) => ({ pk: it.pk, sk: it.sk }));
      await batchDelete(keys);
      total += keys.length;
      console.log(`Deleted: ${total}`);
    }

    lastKey = resp.LastEvaluatedKey;
    if (!lastKey) break;
  }

  console.log(`✅ Done. Deleted ${total} items.`);
}

main().catch((e) => {
  console.error("❌ Failed:", e);
  process.exit(1);
});
