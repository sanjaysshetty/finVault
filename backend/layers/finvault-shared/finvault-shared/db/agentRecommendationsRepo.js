"use strict";

/**
 * Repository for AgentRecommendations — Opportunity Engine / Deep Dive
 * recommendations and their scenario-run history (Part 5/6 plan §6.4).
 *
 * Key shape: PK=accountId, SK="REC#<recId>" (header) or
 * "REC#<recId>#SCENARIO#<ts>" (one item per scenario run). Opportunity
 * Engine's Python handler writes headers directly via boto3 (no cross-
 * language repo sharing) — this module is for the Node-side read API
 * (opportunity-engine-read) and, later, Deep Dive's scenario-run/approval
 * writes once that surface exists.
 */

const { GetCommand, PutCommand, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { doc } = require("./client");

const TABLE = process.env.AGENT_RECOMMENDATIONS_TABLE || "AgentRecommendations";

/** List every recommendation header for an account, newest first. */
async function listRecommendations(accountId) {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "accountId = :accountId AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":accountId": accountId, ":prefix": "REC#" },
    })
  );
  // Headers only (sk == "REC#<id>", no further segments) — scenario-run
  // items for a given recommendation sort after its own header but are
  // excluded here since callers list cards, not full detail.
  const items = (res.Items || []).filter((it) => it.sk.split("#").length === 2);
  items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return items;
}

/** One recommendation header plus its full scenario-run history, in one query. */
async function getRecommendationWithHistory(accountId, recommendationId) {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "accountId = :accountId AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":accountId": accountId,
        ":prefix": `REC#${recommendationId}`,
      },
    })
  );
  const items = res.Items || [];
  const header = items.find((it) => it.sk === `REC#${recommendationId}`) || null;
  const scenarioRuns = items.filter((it) => it.sk !== `REC#${recommendationId}`);
  return { header, scenarioRuns };
}

async function putRecommendation(item) {
  await doc.send(new PutCommand({ TableName: TABLE, Item: item }));
}

async function updateRecommendationStatus(accountId, recommendationId, status, extraFields = {}) {
  const updates = { status, updatedAt: new Date().toISOString(), ...extraFields };
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
      Key: { accountId, sk: `REC#${recommendationId}` },
      UpdateExpression: "SET " + setExprs.join(", "),
      ExpressionAttributeNames: attrNames,
      ExpressionAttributeValues: attrValues,
      ConditionExpression: "attribute_exists(accountId)",
    })
  );
}

module.exports = {
  listRecommendations,
  getRecommendationWithHistory,
  putRecommendation,
  updateRecommendationStatus,
};
