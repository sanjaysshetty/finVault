import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import pLimit from "p-limit";

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

const OLD_TABLE = process.env.OLD_TABLE || "ReceiptLedger";
const NEW_TABLE = process.env.NEW_TABLE || "StoreReceiptLedger";
const TARGET_USER_ID = process.env.TARGET_USER_ID || "a4989438-e001-7005-babe-0e92e91c028a";


// If you want historical data to be treated as already curated, set this to false
const DEFAULT_NEEDS_CURATION = (process.env.DEFAULT_NEEDS_CURATION || "true") === "true";

// Max 25 items per BatchWrite
const BATCH_SIZE = 25;

// Parallelism for batch writes (keep modest)
const limit = pLimit(5);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

function nowIso() {
  return new Date().toISOString();
}

function withCurationFields(item) {
  // Preserve existing timestamps if present
  const updatedAt = item.updatedAt || item.createdAt || nowIso();

  // Ensure pk/sk exist
  const pk = item.pk;
  const sk = item.sk;
  if (!pk || !sk) return null;

    return {
    ...item,

    // 🔴 override old userId
    userId: TARGET_USER_ID,

    needsCuration: DEFAULT_NEEDS_CURATION,
    curationKey: "CURATION",
    curationSort: `${DEFAULT_NEEDS_CURATION ? "NEEDS" : "CURATED"}#${updatedAt}#${pk}#${sk}`,
    updatedAt,
    };
}

async function batchWriteAll(items) {
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    let chunk = items.slice(i, i + BATCH_SIZE).map((it) => ({
      PutRequest: { Item: it },
    }));

    // Retry unprocessed items
    for (let attempt = 0; attempt < 8; attempt++) {
      const resp = await ddb.send(
        new BatchWriteCommand({
          RequestItems: { [NEW_TABLE]: chunk },
        })
      );

      const unprocessed = resp?.UnprocessedItems?.[NEW_TABLE] || [];
      if (!unprocessed.length) break;

      chunk = unprocessed;
      const backoff = Math.min(2000, 200 * Math.pow(2, attempt));
      console.log(`UnprocessedItems=${unprocessed.length}, retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

async function main() {
  console.log(`Region: ${REGION}`);
  console.log(`Migrating from ${OLD_TABLE} -> ${NEW_TABLE}`);
  console.log(`DEFAULT_NEEDS_CURATION=${DEFAULT_NEEDS_CURATION}`);

  let scanned = 0;
  let written = 0;
  let skipped = 0;

  let ExclusiveStartKey = undefined;

  do {
    const resp = await ddb.send(
      new ScanCommand({
        TableName: OLD_TABLE,
        ExclusiveStartKey,
      })
    );

    const items = resp.Items || [];
    scanned += items.length;

    // transform items
    const transformed = [];
    for (const it of items) {
      const out = withCurationFields(it);
      if (!out) {
        skipped += 1;
        continue;
      }
      transformed.push(out);
    }

    // write in parallel in smaller sub-batches
    const tasks = [];
    for (let i = 0; i < transformed.length; i += 250) {
      const part = transformed.slice(i, i + 250);
      tasks.push(limit(async () => batchWriteAll(part)));
    }
    await Promise.all(tasks);

    written += transformed.length;

    ExclusiveStartKey = resp.LastEvaluatedKey;

    console.log(
      `Progress: scanned=${scanned}, written=${written}, skipped=${skipped}, nextKey=${ExclusiveStartKey ? "YES" : "NO"}`
    );
  } while (ExclusiveStartKey);

  console.log("DONE ✅");
  console.log({ scanned, written, skipped });
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
