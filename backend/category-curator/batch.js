// backend/category-curator/batch.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const RAW_TABLE = process.env.RAW_TABLE;
const RAW_GSI_NAME = process.env.RAW_GSI_NAME || "GSI1";
const BUCKET = process.env.ANALYTICS_BUCKET;
const PREFIX = process.env.ANALYTICS_PREFIX || "curated_line_items";
const MAX_ITEMS = parseInt(process.env.MAX_ITEMS_PER_RUN || "200", 10);

function isoNow() {
  return new Date().toISOString();
}

function dtFromIso(iso) {
  return String(iso || "").slice(0, 10);
}

export const handler = async () => {
  const startedAt = isoNow();
  console.log("BatchCurationAndExport start", { startedAt, MAX_ITEMS });

  // IMPORTANT:
  // Step 2 will make sure your writes set:
  //   curationKey = "CURATION"
  //   curationSort = "NEEDS#<updatedAt>#<pk>#<sk>"
  //
  // For now we just query any NEEDS items and export them raw (to prove plumbing).

  const out = [];
  let lastEvaluatedKey = undefined;

  while (out.length < MAX_ITEMS) {
    const page = await ddb.send(
      new QueryCommand({
        TableName: RAW_TABLE,
        IndexName: RAW_GSI_NAME,
        KeyConditionExpression:
          "#ck = :ck AND begins_with(#cs, :needs)",
        ExpressionAttributeNames: {
          "#ck": "curationKey",
          "#cs": "curationSort",
        },
        ExpressionAttributeValues: {
          ":ck": "CURATION",
          ":needs": "NEEDS#",
        },
        Limit: Math.min(100, MAX_ITEMS - out.length),
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );

    const items = page.Items || [];
    out.push(...items);

    lastEvaluatedKey = page.LastEvaluatedKey;
    if (!lastEvaluatedKey || items.length === 0) break;
  }

  console.log("Fetched NEEDS items", { count: out.length });

  // Export the raw NEEDS items into S3 as JSONL (partitioned by today for now).
  // Step 3 will export curated line items instead.
  const dt = dtFromIso(startedAt);
  const key = `${PREFIX}/dt=${dt}/raw-needs-${startedAt.replace(/[:.]/g, "-")}.jsonl`;

  const body = out.map((x) => JSON.stringify(x)).join("\n") + (out.length ? "\n" : "");
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/json",
    })
  );

  console.log("Wrote S3 export", { bucket: BUCKET, key });

  // Optional: mark them as "seen" (we won't flip DONE until Step 3/4)
  // This is intentionally a no-op for now to avoid changing your data prematurely.

  return {
    ok: true,
    startedAt,
    count: out.length,
    s3Key: key,
  };
};
