"use strict";

/**
 * Repository for the receipt ledger table (StoreReceiptLedger) — the
 * most multi-consumer table in the app: spending-api (read/update),
 * receipt-extractor (write), category-curator (scan + update), budget-api
 * (read/write). PK=pk, SK=sk, GSI1=curationKey/curationSort,
 * UserDateIndex=userId/date.
 *
 * Covers the shapes actually in use today; each consumer still builds its
 * own filter/update expressions for anything more specific than these.
 */

const {
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
  BatchWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { doc } = require("./client");

function tableName() {
  const t = process.env.TABLE_NAME || process.env.RECEIPT_LEDGER_TABLE || "StoreReceiptLedger";
  return t;
}

async function putItem(item) {
  await doc.send(new PutCommand({ TableName: tableName(), Item: item }));
}

/** Chunks into batches of 25 (DynamoDB's BatchWrite limit), retries UnprocessedItems with backoff. */
async function batchWriteItems(putRequests) {
  const table = tableName();
  for (let i = 0; i < putRequests.length; i += 25) {
    let chunk = putRequests.slice(i, i + 25);
    for (let attempt = 0; attempt < 6; attempt++) {
      const resp = await doc.send(new BatchWriteCommand({ RequestItems: { [table]: chunk } }));
      const unprocessed = resp?.UnprocessedItems?.[table] || [];
      if (!unprocessed.length) break;
      chunk = unprocessed;
      await new Promise((r) => setTimeout(r, 200 * Math.pow(2, attempt)));
    }
  }
}

async function updateItem(pk, sk, updateExpression, expressionAttributeValues, expressionAttributeNames) {
  await doc.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk, sk },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ...(expressionAttributeNames ? { ExpressionAttributeNames: expressionAttributeNames } : {}),
    })
  );
}

/** Query by UserDateIndex — all items for a user, optionally filtered to one date, newest first. */
async function queryByUserDate(userId, date) {
  const params = {
    TableName: tableName(),
    IndexName: process.env.DATE_INDEX_NAME || "UserDateIndex",
    ScanIndexForward: false,
    ExpressionAttributeNames: { "#uid": "userId" },
    ExpressionAttributeValues: { ":uid": userId },
    KeyConditionExpression: "#uid = :uid",
  };
  if (date) {
    params.KeyConditionExpression = "#uid = :uid AND #d = :d";
    params.ExpressionAttributeNames["#d"] = "date";
    params.ExpressionAttributeValues[":d"] = date;
  }
  const out = await doc.send(new QueryCommand(params));
  return out.Items || [];
}

/** Query by GSI1 (curationKey/curationSort) — e.g. the "NEEDS#..." curation queue. */
async function queryByCurationKey(curationKey, beginsWithSort) {
  const out = await doc.send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: "GSI1",
      KeyConditionExpression: "curationKey = :ck AND begins_with(curationSort, :cs)",
      ExpressionAttributeValues: { ":ck": curationKey, ":cs": beginsWithSort },
    })
  );
  return out.Items || [];
}

/** Matches category-curator's existing scan-based "needsCuration" lookup — not yet upgraded to a GSI1 query. */
async function scanNeedsCuration(limit, exclusiveStartKey) {
  const out = await doc.send(
    new ScanCommand({
      TableName: tableName(),
      FilterExpression: "needsCuration = :t",
      ExpressionAttributeValues: { ":t": true },
      Limit: limit,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    })
  );
  return out;
}

module.exports = {
  putItem,
  batchWriteItems,
  updateItem,
  queryByUserDate,
  queryByCurationKey,
  scanNeedsCuration,
};
