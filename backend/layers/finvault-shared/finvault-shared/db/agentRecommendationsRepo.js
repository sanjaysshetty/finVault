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

const { PutCommand, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
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

/**
 * Reads the single most recent ScanRun summary item (sk="SCANRUN#<scanId>",
 * scanId is an ISO timestamp so sk sorts chronologically for free) --
 * used by the trigger route's rolling-7-day recency prompt ("already
 * scanned N days ago, run again anyway?") and its in-progress check.
 * Deliberately NOT scoped to a calendar week -- a scan from 2 days ago
 * in the previous ISO week still counts as "recent." Doesn't collide
 * with listRecommendations' query since that one is scoped server-side
 * to sk begins_with "REC#".
 */
async function getMostRecentScanRun(accountId) {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "accountId = :accountId AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":accountId": accountId, ":prefix": "SCANRUN#" },
      ScanIndexForward: false,
      Limit: 1,
    })
  );
  return (res.Items && res.Items[0]) || null;
}

/** The last `limit` ScanRuns for this account, newest first -- backs the
 * scan-history UI (list of past runs, select one to see its candidates).
 * Unlike getMostRecentScanRun this returns every status, not just the
 * latest, so a failed or in-progress run is still visible in the list. */
async function listRecentScanRuns(accountId, limit = 10) {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "accountId = :accountId AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":accountId": accountId, ":prefix": "SCANRUN#" },
      ScanIndexForward: false,
      Limit: limit,
    })
  );
  return res.Items || [];
}

/** Every recommendation (deep-dived or screened-only) produced by one
 * specific scan. No GSI on scanId -- this table is personal-scale (one
 * account's own scans), so filtering the already-fetched REC# items in
 * code is simpler than adding an index for it. Recommendations from
 * scans run before the scanId field existed won't match any scanId and
 * are correctly excluded here, not just silently dropped. */
async function listRecommendationsForScan(accountId, scanId) {
  const all = await listRecommendations(accountId);
  return all.filter((it) => it.scanId === scanId);
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
  listRecommendationsForScan,
  getRecommendationWithHistory,
  getMostRecentScanRun,
  listRecentScanRuns,
  putRecommendation,
  updateRecommendationStatus,
};
