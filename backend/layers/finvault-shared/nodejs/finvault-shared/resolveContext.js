"use strict";

/**
 * resolveContext — shared auth + account resolver.
 *
 * Called at the top of every authenticated handler.
 * Reads the JWT sub (userId) and the X-Account-Id request header,
 * then verifies the caller is a member of that account via FinAccountMembers.
 *
 * For the primary account (accountId === userId) it performs a lazy bootstrap:
 * if no ACCOUNT_META / MEMBER records exist yet it creates them idempotently,
 * so existing users need no data migration.
 *
 * Returns: { userId, accountId, role, pages, isPrimary }
 * Throws:  401 if JWT is missing, 403 if not a member of the requested account.
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} = require("@aws-sdk/lib-dynamodb");

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const MEMBERS_TABLE  = process.env.FIN_ACCOUNT_MEMBERS_TABLE || "FinAccountMembers";
const ACCOUNTS_TABLE = process.env.FIN_ACCOUNTS_TABLE        || "FinAccounts";

/** Default pages object granted to the account owner. */
const ALL_PAGES_WRITE = {
  portfolio:         "write",
  stocks:            "write",
  crypto:            "write",
  bullion:           "write",
  futures:           "write",
  options:           "write",
  fixedIncome:       "write",
  otherAssets:       "write",
  nav:               "write",
  liabilities:       "write",
  insurance:         "write",
  spendingDashboard: "write",
  receiptsLedger:    "write",
};

/**
 * bootstrapPrimaryAccount — idempotently creates ACCOUNT_META and MEMBER
 * records for a user's primary account (accountId === userId).
 * Safe to call multiple times (uses ConditionExpression on each put).
 */
async function bootstrapPrimaryAccount(userId) {
  const now = new Date().toISOString();

  await doc.send(new PutCommand({
    TableName: ACCOUNTS_TABLE,
    Item: {
      accountId:   userId,
      ownerId:     userId,
      accountName: "My Account",
      isPrimary:   true,
      status:      "ACTIVE",
      createdAt:   now,
    },
    ConditionExpression: "attribute_not_exists(accountId)",
  })).catch(e => {
    if (e.name !== "ConditionalCheckFailedException") throw e;
  });

  await doc.send(new PutCommand({
    TableName: MEMBERS_TABLE,
    Item: {
      accountId: userId,
      userId,
      role:      "owner",
      pages:     ALL_PAGES_WRITE,
      gsi1pk:    userId,          // GSI1 PK — userId → all accounts for this user
      gsi1sk:    `ACCOUNT#${userId}`,
      isPrimary: true,
      joinedAt:  now,
    },
    ConditionExpression:
      "attribute_not_exists(accountId) AND attribute_not_exists(userId)",
  })).catch(e => {
    if (e.name !== "ConditionalCheckFailedException") throw e;
  });
}

/**
 * resolveContext — main entry point.
 */
async function resolveContext(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  const userId = claims?.sub;
  if (!userId) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }

  // X-Account-Id header selects which account to operate on.
  // Absent or empty → default to primary account (accountId = userId).
  const headerAccountId = (
    event?.headers?.["x-account-id"] ||
    event?.headers?.["X-Account-Id"] ||
    ""
  ).trim();
  const accountId = headerAccountId || userId;

  // Look up membership record.
  const result = await doc.send(new GetCommand({
    TableName: MEMBERS_TABLE,
    Key: { accountId, userId },
  }));

  let member = result.Item;

  if (!member) {
    if (accountId === userId) {
      // Primary account — lazy bootstrap on first request.
      await bootstrapPrimaryAccount(userId);
      member = {
        accountId: userId,
        userId,
        role:      "owner",
        pages:     ALL_PAGES_WRITE,
        isPrimary: true,
      };
    } else {
      const err = new Error("Forbidden: not a member of this account");
      err.statusCode = 403;
      throw err;
    }
  } else if (accountId !== userId) {
    // Non-primary account: verify the account itself is not soft-deleted.
    const acctRes = await doc.send(new GetCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { accountId },
      ProjectionExpression: "#s",
      ExpressionAttributeNames: { "#s": "status" },
    }));
    if (!acctRes.Item || acctRes.Item.status === "DELETED") {
      const err = new Error("Forbidden: account not found or has been deleted");
      err.statusCode = 403;
      throw err;
    }
  }

  return {
    userId,
    accountId:  member.accountId,
    role:       member.role,                  // "owner" | "member"
    pages:      member.pages || ALL_PAGES_WRITE,
    isPrimary:  member.isPrimary || false,
  };
}

/**
 * assertWrite — throws 403 if the caller does not have write access to `page`.
 * Owners always pass. Members need pages[page] === "write".
 *
 * @param {object} ctx  - result of resolveContext()
 * @param {string} page - one of the 13 page keys (e.g. "stocks", "liabilities")
 */
function assertWrite(ctx, page) {
  if (ctx.role === "owner") return;
  if (ctx.pages?.[page] === "write") return;
  const err = new Error(`Forbidden: write access required for page '${page}'`);
  err.statusCode = 403;
  throw err;
}

/**
 * assertRead — throws 403 if the caller has "none" access to `page`.
 */
function assertRead(ctx, page) {
  if (ctx.role === "owner") return;
  if ((ctx.pages?.[page] || "none") !== "none") return;
  const err = new Error(`Forbidden: no access to page '${page}'`);
  err.statusCode = 403;
  throw err;
}

module.exports = { resolveContext, assertWrite, assertRead, ALL_PAGES_WRITE };
