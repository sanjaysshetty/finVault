"use strict";

/**
 * Repository for FinAccounts / FinAccountMembers — the account/membership
 * tables that resolveContext.js (called by every authenticated handler),
 * accounts-api, and post-confirmation all touch.
 *
 * Deliberately NOT a full wrapper over every operation those three files
 * perform — accounts-api in particular has many bespoke, single-consumer
 * operations (invite lifecycle, batch member writes) that don't benefit
 * from being forced into generic repo methods. This exports only the
 * handful of primitives that are genuinely duplicated verbatim across
 * multiple files today (member/account lookup and the two bootstrap writes),
 * plus the shared client for everything else those files still query/write
 * directly with their own Commands.
 */

const { GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { doc } = require("./client");

const MEMBERS_TABLE  = process.env.FIN_ACCOUNT_MEMBERS_TABLE || "FinAccountMembers";
const ACCOUNTS_TABLE = process.env.FIN_ACCOUNTS_TABLE        || "FinAccounts";

async function getMember(accountId, userId) {
  const out = await doc.send(
    new GetCommand({ TableName: MEMBERS_TABLE, Key: { accountId, userId } })
  );
  return out.Item || null;
}

async function getAccount(accountId, projectionExpression, expressionAttributeNames) {
  const out = await doc.send(
    new GetCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { accountId },
      ...(projectionExpression ? { ProjectionExpression: projectionExpression } : {}),
      ...(expressionAttributeNames ? { ExpressionAttributeNames: expressionAttributeNames } : {}),
    })
  );
  return out.Item || null;
}

async function putMember(member, conditionExpression) {
  await doc.send(
    new PutCommand({
      TableName: MEMBERS_TABLE,
      Item: member,
      ...(conditionExpression ? { ConditionExpression: conditionExpression } : {}),
    })
  );
}

async function putAccount(account, conditionExpression) {
  await doc.send(
    new PutCommand({
      TableName: ACCOUNTS_TABLE,
      Item: account,
      ...(conditionExpression ? { ConditionExpression: conditionExpression } : {}),
    })
  );
}

module.exports = {
  doc,
  MEMBERS_TABLE,
  ACCOUNTS_TABLE,
  getMember,
  getAccount,
  putMember,
  putAccount,
};
