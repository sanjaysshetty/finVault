"use strict";

/**
 * Repository for PaperTrades. Single consumer today (paper-trade-api), but
 * the table already has well-named query functions living inside app.js —
 * this just gives them a home in the shared layer with the shared client,
 * named to match the existing functions closely so migrating the consumer
 * is close to a pure relocation.
 */

const {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const { doc } = require("./client");

const TABLE = process.env.PAPER_TRADES_TABLE || "PaperTrades";

async function getTrade(accountId, tradeId) {
  const out = await doc.send(
    new GetCommand({ TableName: TABLE, Key: { accountId, tradeId } })
  );
  return out.Item || null;
}

async function putTrade(item) {
  await doc.send(new PutCommand({ TableName: TABLE, Item: item }));
}

async function listOrdersByStatus(accountId, modeStatus) {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "ModeStatusIndex",
      KeyConditionExpression: "#pk = :pk",
      FilterExpression: "accountId = :accountId",
      ExpressionAttributeNames: { "#pk": "modeStatus" },
      ExpressionAttributeValues: { ":pk": modeStatus, ":accountId": accountId },
      ScanIndexForward: false,
    })
  );
  return res.Items || [];
}

/** All orders in a given modeStatus across all accounts — used by the auto-fill scheduler. */
async function listAllOrdersByStatus(modeStatus) {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "ModeStatusIndex",
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "modeStatus" },
      ExpressionAttributeValues: { ":pk": modeStatus },
    })
  );
  return res.Items || [];
}

async function updateTrade(accountId, tradeId, fields) {
  const updates = { updatedAt: new Date().toISOString(), ...fields };
  const setExprs = [];
  const attrNames = {};
  const attrValues = {};
  for (const [k, v] of Object.entries(updates)) {
    setExprs.push(`#${k} = :${k}`);
    attrNames[`#${k}`] = k;
    attrValues[`:${k}`] = v;
  }
  await doc.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { accountId, tradeId },
      UpdateExpression: "SET " + setExprs.join(", "),
      ExpressionAttributeNames: attrNames,
      ExpressionAttributeValues: attrValues,
    })
  );
}

module.exports = { getTrade, putTrade, listOrdersByStatus, listAllOrdersByStatus, updateTrade };
