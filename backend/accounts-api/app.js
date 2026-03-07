"use strict";

/**
 * AccountsApi — manage accounts, members, and invites.
 *
 * Routes:
 *   GET    /accounts                             — list caller's accounts (lazy-bootstraps primary)
 *   POST   /accounts                             — create a new account (caller becomes owner)
 *   PATCH  /accounts/:accountId                  — rename account (owner only)
 *   DELETE /accounts/:accountId                  — soft-delete account (owner only)
 *
 *   GET    /accounts/:accountId/members          — list members (owner only)
 *   PATCH  /accounts/:accountId/members/:userId  — update member page roles (owner only)
 *   DELETE /accounts/:accountId/members/:userId  — remove member (owner only)
 *
 *   GET    /accounts/:accountId/invites          — list pending invites (owner only)
 *   POST   /accounts/:accountId/invites          — send invite (owner only)
 *   DELETE /accounts/:accountId/invites/:email   — revoke invite (owner only)
 *
 *   POST   /invites/:inviteId/accept             — accept invite (new user, no JWT required here;
 *                                                  bearer token IS required so API gateway auth
 *                                                  is disabled — caller provides JWT manually)
 */

const crypto = require("crypto");

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  BatchWriteCommand,
} = require("@aws-sdk/lib-dynamodb");

const {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} = require("@aws-sdk/client-cognito-identity-provider");

const { json, badRequest, notFound } = require("finvault-shared/http");
const { resolveContext, ALL_PAGES_WRITE } = require("finvault-shared/resolveContext");

/* ── DynamoDB client ─────────────────────────────────────────── */

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const MEMBERS_TABLE  = process.env.FIN_ACCOUNT_MEMBERS_TABLE || "FinAccountMembers";
const ACCOUNTS_TABLE = process.env.FIN_ACCOUNTS_TABLE        || "FinAccounts";
const INVITES_TABLE  = process.env.FIN_ACCOUNT_INVITES_TABLE || "FinAccountInvitesV2";
const ASSETS_TABLE   = process.env.FIN_ASSETS_TABLE          || "finAssets";
const SPENDING_TABLE = process.env.SPENDING_TABLE            || "StoreReceiptLedger";
const USER_POOL_ID   = process.env.USER_POOL_ID              || "";

const cognito = new CognitoIdentityProviderClient({});

/* ── Helpers ─────────────────────────────────────────────────── */

function getMethod(event) {
  return event?.requestContext?.http?.method || event?.httpMethod || "GET";
}

function getPath(event) {
  return event?.rawPath || event?.requestContext?.http?.path || event?.path || "/";
}

function parseBody(event) {
  if (!event?.body) return null;
  try { return JSON.parse(event.body); } catch { return null; }
}

function pathParam(event, name) {
  return event?.pathParameters?.[name] || null;
}

/** Default read-only pages object for new members. */
function defaultMemberPages() {
  return Object.fromEntries(
    Object.keys(ALL_PAGES_WRITE).map(k => [k, "none"])
  );
}

/** Validate and sanitize an incoming pages object. */
function sanitizePages(input) {
  const valid = Object.keys(ALL_PAGES_WRITE);
  const result = {};
  for (const key of valid) {
    const val = input[key];
    if (val === "read" || val === "write" || val === "none") {
      result[key] = val;
    } else {
      result[key] = "none"; // unknown values → no access
    }
  }
  return result;
}

/** Require the caller to be an owner of `accountId`; throws 403 otherwise. */
function requireOwner(ctx, accountId) {
  if (ctx.role !== "owner" || ctx.accountId !== accountId) {
    const err = new Error("Forbidden: owner access required");
    err.statusCode = 403;
    throw err;
  }
}

/* ── GET /accounts ───────────────────────────────────────────── */

async function listAccounts(event) {
  // listAccounts is user-scoped, not account-scoped — strip X-Account-Id so
  // resolveContext always bootstraps/uses the primary account context regardless
  // of what account the caller currently has selected.
  const ev = { ...event, headers: { ...(event.headers || {}) } };
  delete ev.headers["x-account-id"];
  delete ev.headers["X-Account-Id"];
  const ctx = await resolveContext(ev);

  // Caller's email from verified JWT claims (ID token contains email; access token does not).
  const callerEmail = (event?.requestContext?.authorizer?.jwt?.claims?.email || "").toLowerCase();

  // Query GSI1 on FinAccountMembers: gsi1pk = userId → all memberships for this user.
  const result = await doc.send(new QueryCommand({
    TableName: MEMBERS_TABLE,
    IndexName: "GSI1",
    KeyConditionExpression: "gsi1pk = :uid",
    ExpressionAttributeValues: { ":uid": ctx.userId },
  }));

  const memberships = result.Items || [];

  // Enrich with account metadata (batch get would be ideal; simple sequential fetch for now).
  const accounts = await Promise.all(
    memberships.map(async (m) => {
      const acct = await doc.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { accountId: m.accountId },
      }));
      const meta = acct.Item || {};

      // Lazy-backfill ownerEmail for accounts this caller owns (covers existing bootstrapped accounts).
      let ownerEmail = meta.ownerEmail || "";
      if (!ownerEmail && m.role === "owner" && callerEmail) {
        ownerEmail = callerEmail;
        await doc.send(new UpdateCommand({
          TableName: ACCOUNTS_TABLE,
          Key: { accountId: m.accountId },
          UpdateExpression: "SET ownerEmail = :email",
          ExpressionAttributeValues: { ":email": callerEmail },
        }));
      }

      return {
        accountId:   m.accountId,
        accountName: meta.accountName || "",
        isPrimary:   m.isPrimary || false,
        role:        m.role,
        pages:       m.pages,
        status:      meta.status || "ACTIVE",
        ownerId:     meta.ownerId,
        ownerEmail,
        createdAt:   meta.createdAt,
      };
    })
  );

  return json(200, accounts.filter(a => a.status !== "DELETED"));
}

/* ── POST /accounts ──────────────────────────────────────────── */

async function createAccount(event) {
  const ctx = await resolveContext(event);
  const body = parseBody(event);
  if (!body) return badRequest("Request body required");

  const accountName = String(body.accountName || "").trim();
  if (!accountName) return badRequest("accountName is required");

  const accountId = crypto.randomUUID();
  const now = new Date().toISOString();
  const ownerEmail = (event?.requestContext?.authorizer?.jwt?.claims?.email || "").toLowerCase();

  // Create account record.
  await doc.send(new PutCommand({
    TableName: ACCOUNTS_TABLE,
    Item: {
      accountId,
      ownerId:     ctx.userId,
      ownerEmail,
      accountName,
      isPrimary:   false,
      status:      "ACTIVE",
      createdAt:   now,
    },
  }));

  // Add owner as a member.
  await doc.send(new PutCommand({
    TableName: MEMBERS_TABLE,
    Item: {
      accountId,
      userId:    ctx.userId,
      role:      "owner",
      pages:     ALL_PAGES_WRITE,
      gsi1pk:    ctx.userId,
      gsi1sk:    `ACCOUNT#${accountId}`,
      isPrimary: false,
      joinedAt:  now,
    },
  }));

  return json(201, { accountId, accountName, ownerId: ctx.userId, createdAt: now });
}

/* ── PATCH /accounts/:accountId ─────────────────────────────── */

async function updateAccount(event) {
  const ctx = await resolveContext(event);
  const accountId = pathParam(event, "accountId");
  if (!accountId) return badRequest("accountId path parameter required");
  requireOwner(ctx, accountId);

  const body = parseBody(event);
  if (!body) return badRequest("Request body required");

  const accountName = String(body.accountName || "").trim();
  if (!accountName) return badRequest("accountName is required");

  await doc.send(new UpdateCommand({
    TableName: ACCOUNTS_TABLE,
    Key: { accountId },
    UpdateExpression: "SET accountName = :name, updatedAt = :now",
    ExpressionAttributeValues: {
      ":name": accountName,
      ":now":  new Date().toISOString(),
    },
    ConditionExpression: "attribute_exists(accountId)",
  })).catch(e => {
    if (e.name === "ConditionalCheckFailedException") throw Object.assign(new Error("Account not found"), { statusCode: 404 });
    throw e;
  });

  return json(200, { accountId, accountName });
}

/* ── Bulk-delete helpers (used by deleteAccount) ─────────────── */

/** Query all items for a given PK (optionally via a GSI). Returns full items. */
async function queryAll(tableName, indexName, pkAttr, pkValue) {
  let lastKey;
  const all = [];
  const params = {
    TableName: tableName,
    KeyConditionExpression: "#pk = :pk",
    ExpressionAttributeNames: { "#pk": pkAttr },
    ExpressionAttributeValues: { ":pk": pkValue },
  };
  if (indexName) params.IndexName = indexName;
  do {
    if (lastKey) params.ExclusiveStartKey = lastKey;
    const resp = await doc.send(new QueryCommand(params));
    all.push(...(resp.Items || []));
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);
  return all;
}

/** Batch-delete items (25 per request) keyed by pkAttr + skAttr. */
async function batchDelete(tableName, pkAttr, skAttr, items) {
  if (!items.length) return;
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    await doc.send(new BatchWriteCommand({
      RequestItems: {
        [tableName]: chunk.map((item) => ({
          DeleteRequest: { Key: { [pkAttr]: item[pkAttr], [skAttr]: item[skAttr] } },
        })),
      },
    }));
  }
}

/* ── DELETE /accounts/:accountId ────────────────────────────── */

async function deleteAccount(event) {
  const ctx = await resolveContext(event);
  const accountId = pathParam(event, "accountId");
  if (!accountId) return badRequest("accountId path parameter required");
  requireOwner(ctx, accountId);

  // Prevent deletion of primary account.
  const acct = await doc.send(new GetCommand({
    TableName: ACCOUNTS_TABLE,
    Key: { accountId },
  }));
  if (!acct.Item) return notFound("Account not found");
  if (acct.Item.isPrimary) {
    return json(400, { message: "Primary account cannot be deleted" });
  }

  // Hard delete — wipe all data scoped to this accountId.
  // finAssets uses userId = accountId (shim pattern), so query base table by userId.
  const [assets, spendingItems, members, invites] = await Promise.all([
    queryAll(ASSETS_TABLE,   null,              "userId",    accountId),
    queryAll(SPENDING_TABLE, "UserDateIndex",   "userId",    accountId),
    queryAll(MEMBERS_TABLE,  null,              "accountId", accountId),
    queryAll(INVITES_TABLE,  "accountId-index", "accountId", accountId),
  ]);

  await Promise.all([
    batchDelete(ASSETS_TABLE,   "userId",    "assetId", assets),
    batchDelete(SPENDING_TABLE, "pk",        "sk",      spendingItems),
    batchDelete(MEMBERS_TABLE,  "accountId", "userId",  members),
    batchDelete(INVITES_TABLE,  "emailLower","accountId", invites),
  ]);

  // Delete the account record last.
  await doc.send(new DeleteCommand({
    TableName: ACCOUNTS_TABLE,
    Key: { accountId },
  }));

  return json(204, null);
}

/* ── GET /accounts/:accountId/members ───────────────────────── */

async function listMembers(event) {
  const ctx = await resolveContext(event);
  const accountId = pathParam(event, "accountId");
  if (!accountId) return badRequest("accountId path parameter required");
  requireOwner(ctx, accountId);

  const result = await doc.send(new QueryCommand({
    TableName: MEMBERS_TABLE,
    KeyConditionExpression: "accountId = :aid",
    ExpressionAttributeValues: { ":aid": accountId },
  }));

  const members = result.Items || [];
  const enriched = await Promise.all(
    members.map(async (m) => ({
      ...m,
      email: m.email || (await lookupCognitoEmail(m.userId)) || null,
    }))
  );
  return json(200, enriched);
}

/* ── PATCH /accounts/:accountId/members/:memberId ───────────── */

async function updateMember(event) {
  const ctx = await resolveContext(event);
  const accountId = pathParam(event, "accountId");
  const memberId  = pathParam(event, "memberId");
  if (!accountId || !memberId) return badRequest("accountId and memberId required");
  requireOwner(ctx, accountId);

  const body = parseBody(event);
  if (!body || !body.pages) return badRequest("pages object required");

  const pages = sanitizePages(body.pages);

  await doc.send(new UpdateCommand({
    TableName: MEMBERS_TABLE,
    Key: { accountId, userId: memberId },
    UpdateExpression: "SET pages = :pages, updatedAt = :now",
    ExpressionAttributeValues: {
      ":pages": pages,
      ":now":   new Date().toISOString(),
    },
    ConditionExpression: "attribute_exists(accountId)",
  })).catch(e => {
    if (e.name === "ConditionalCheckFailedException") throw Object.assign(new Error("Member not found"), { statusCode: 404 });
    throw e;
  });

  return json(200, { accountId, userId: memberId, pages });
}

/* ── DELETE /accounts/:accountId/members/:memberId ──────────── */

async function removeMember(event) {
  const ctx = await resolveContext(event);
  const accountId = pathParam(event, "accountId");
  const memberId  = pathParam(event, "memberId");
  if (!accountId || !memberId) return badRequest("accountId and memberId required");
  requireOwner(ctx, accountId);

  // Prevent removing the owner themselves.
  if (memberId === ctx.userId) {
    return json(400, { message: "Owner cannot remove themselves" });
  }

  // Fetch the member record first to get their email (needed to clean up the invite).
  const memberRes = await doc.send(new GetCommand({
    TableName: MEMBERS_TABLE,
    Key: { accountId, userId: memberId },
  }));
  const email = memberRes.Item?.email || (await lookupCognitoEmail(memberId));

  // Remove member record.
  await doc.send(new DeleteCommand({
    TableName: MEMBERS_TABLE,
    Key: { accountId, userId: memberId },
  }));

  // Remove the invite record so it no longer shows as "accepted" in the invites list.
  // This also allows a clean re-invite in the future.
  if (email) {
    await doc.send(new DeleteCommand({
      TableName: INVITES_TABLE,
      Key: { emailLower: email.toLowerCase(), accountId },
    })).catch(() => {}); // non-fatal if no invite record exists
  }

  return json(204, null);
}

/* ── GET /accounts/:accountId/invites ────────────────────────── */

async function listInvites(event) {
  const ctx = await resolveContext(event);
  const accountId = pathParam(event, "accountId");
  if (!accountId) return badRequest("accountId path parameter required");
  requireOwner(ctx, accountId);

  const result = await doc.send(new QueryCommand({
    TableName: INVITES_TABLE,
    IndexName: "accountId-index",
    KeyConditionExpression: "accountId = :aid",
    ExpressionAttributeValues: { ":aid": accountId },
  }));

  return json(200, result.Items || []);
}

/* ── Invite helpers ──────────────────────────────────────────── */

/**
 * Look up a user's email in Cognito by their sub (userId).
 * Returns email string or null.
 */
async function lookupCognitoEmail(userId) {
  if (!USER_POOL_ID) return null;
  try {
    const result = await cognito.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Filter:     `sub = "${userId}"`,
      Limit:      1,
    }));
    const user = result.Users?.[0];
    return user?.Attributes?.find((a) => a.Name === "email")?.Value || null;
  } catch (e) {
    console.warn("lookupCognitoEmail failed:", e.message);
    return null;
  }
}

/**
 * Look up a confirmed user in Cognito by email.
 * Returns their Cognito sub (userId) or null if not found / not confirmed.
 */
async function lookupCognitoUser(email) {
  if (!USER_POOL_ID) return null;
  try {
    const result = await cognito.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Filter:     `email = "${email}"`,
      Limit:      1,
    }));
    const user = result.Users?.[0];
    if (!user || user.UserStatus === "UNCONFIRMED") return null;
    return user.Attributes?.find((a) => a.Name === "sub")?.Value || null;
  } catch (e) {
    console.warn("createInvite: Cognito lookup failed:", e.message);
    return null; // non-fatal — fall back to pending invite
  }
}

/**
 * Directly add a user as a member and mark (or create) the invite as ACCEPTED.
 * Used when the invitee is already a registered Cognito user.
 */
async function directAccept(accountId, email, userId, pages, now) {
  await doc.send(new PutCommand({
    TableName: MEMBERS_TABLE,
    Item: {
      accountId,
      userId,
      email,
      role:      "member",
      pages,
      gsi1pk:    userId,
      gsi1sk:    `ACCOUNT#${accountId}`,
      isPrimary: false,
      joinedAt:  now,
    },
  }));
  await doc.send(new UpdateCommand({
    TableName: INVITES_TABLE,
    Key: { emailLower: email, accountId },
    UpdateExpression:
      "SET #s = :accepted, acceptedAt = :now, acceptedBy = :uid, pages = :pages, updatedAt = :now",
    ExpressionAttributeNames:  { "#s": "status" },
    ExpressionAttributeValues: {
      ":accepted": "ACCEPTED",
      ":now":      now,
      ":uid":      userId,
      ":pages":    pages,
    },
  }));
}

/* ── POST /accounts/:accountId/invites ───────────────────────── */

async function createInvite(event) {
  const ctx = await resolveContext(event);
  const accountId = pathParam(event, "accountId");
  if (!accountId) return badRequest("accountId path parameter required");
  requireOwner(ctx, accountId);

  const body = parseBody(event);
  if (!body) return badRequest("Request body required");

  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return badRequest("Valid email required");

  const pages    = body.pages ? sanitizePages(body.pages) : defaultMemberPages();
  const inviteId = crypto.randomUUID();
  const now      = new Date().toISOString();

  // Check Cognito: if the invitee is already a registered user we can skip the
  // pending-invite flow entirely and add them as a member immediately.
  // This handles: fresh invite to existing user, re-invite after remove, and
  // the broken state where a previous re-invite left a stale PENDING record.
  const existingUserId = await lookupCognitoUser(email);

  // Check existing invite record (same email + account = same PK+SK).
  const existing = await doc.send(new GetCommand({
    TableName: INVITES_TABLE,
    Key: { emailLower: email, accountId },
  }));

  if (existing.Item?.status === "PENDING") {
    if (existingUserId) {
      // User is already registered — the pending invite will never be auto-accepted
      // via PostConfirmation. Accept it now directly.
      await directAccept(accountId, email, existingUserId, pages, now);
      return json(200, { accountId, email, role: "member", pages });
    }
    return json(409, { message: "A pending invite already exists for this email and account" });
  }

  if (existing.Item?.status === "ACCEPTED") {
    // Previously accepted invite (member was removed). Re-add using stored userId
    // or the Cognito lookup result.
    const userId = existing.Item.acceptedBy || existingUserId;
    if (!userId) {
      return json(409, { message: "Cannot re-add: user identity unknown. Revoke the invite and ask the user to sign in again." });
    }
    await directAccept(accountId, email, userId, pages, now);
    return json(200, { accountId, email, role: "member", pages, reAdded: true });
  }

  // No existing invite record.
  if (existingUserId) {
    // Already registered but never invited to this account — add immediately.
    await doc.send(new PutCommand({
      TableName: INVITES_TABLE,
      Item: {
        emailLower:  email,
        accountId,
        inviteId,
        invitedBy:   ctx.userId,
        pages,
        status:      "ACCEPTED",
        acceptedBy:  existingUserId,
        createdAt:   now,
        acceptedAt:  now,
      },
    }));
    await doc.send(new PutCommand({
      TableName: MEMBERS_TABLE,
      Item: {
        accountId,
        userId:    existingUserId,
        role:      "member",
        pages,
        gsi1pk:    existingUserId,
        gsi1sk:    `ACCOUNT#${accountId}`,
        isPrimary: false,
        joinedAt:  now,
      },
    }));
    return json(200, { accountId, email, role: "member", pages });
  }

  // Invitee not yet registered — create a pending invite.
  // PostConfirmation Lambda will accept it when they sign up.
  await doc.send(new PutCommand({
    TableName: INVITES_TABLE,
    Item: {
      emailLower:  email,
      accountId,
      inviteId,
      invitedBy:   ctx.userId,
      pages,
      status:      "PENDING",
      createdAt:   now,
    },
  }));

  return json(201, { inviteId, email, accountId, pages, status: "PENDING" });
}

/* ── DELETE /accounts/:accountId/invites/:emailEncoded ──────── */

async function revokeInvite(event) {
  const ctx = await resolveContext(event);
  const accountId    = pathParam(event, "accountId");
  const emailEncoded = pathParam(event, "emailEncoded");
  if (!accountId || !emailEncoded) return badRequest("accountId and email path parameters required");
  requireOwner(ctx, accountId);

  const email = decodeURIComponent(emailEncoded).toLowerCase();

  await doc.send(new DeleteCommand({
    TableName: INVITES_TABLE,
    Key: { emailLower: email, accountId },
  }));

  return json(204, null);
}

/* ── POST /invites/:inviteId/accept (no JWT auth on API GW) ─── */

async function acceptInvite(event) {
  // This route has Authorizer: NONE at API Gateway level, but the caller
  // must still supply a valid Cognito Bearer token so we can get their userId.
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  const userId = claims?.sub;
  if (!userId) return json(401, { message: "Unauthorized" });

  const inviteId = pathParam(event, "inviteId");
  if (!inviteId) return badRequest("inviteId path parameter required");

  // Look up the invite by inviteId-index.
  const result = await doc.send(new QueryCommand({
    TableName: INVITES_TABLE,
    IndexName: "inviteId-index",
    KeyConditionExpression: "inviteId = :id",
    ExpressionAttributeValues: { ":id": inviteId },
    Limit: 1,
  }));

  const invite = result.Items?.[0];
  if (!invite) return notFound("Invite not found or already used");
  if (invite.status !== "PENDING") {
    return json(410, { message: "Invite has already been used or revoked" });
  }

  // Verify email matches (caller's email from JWT claims).
  const callerEmail = (claims.email || "").toLowerCase();
  if (callerEmail && invite.emailLower && callerEmail !== invite.emailLower) {
    return json(403, { message: "This invite was sent to a different email address" });
  }

  const now = new Date().toISOString();
  const { accountId, pages } = invite;

  // Add caller as member.
  await doc.send(new PutCommand({
    TableName: MEMBERS_TABLE,
    Item: {
      accountId,
      userId,
      email:     invite.emailLower || null,
      role:      "member",
      pages:     pages || {},
      gsi1pk:    userId,
      gsi1sk:    `ACCOUNT#${accountId}`,
      isPrimary: false,
      joinedAt:  now,
    },
    ConditionExpression:
      "attribute_not_exists(accountId) AND attribute_not_exists(userId)",
  })).catch(e => {
    if (e.name !== "ConditionalCheckFailedException") throw e;
    // Already a member — that's fine, just mark invite as used.
  });

  // Mark invite as ACCEPTED.
  await doc.send(new UpdateCommand({
    TableName: INVITES_TABLE,
    Key: { emailLower: invite.emailLower, accountId },
    UpdateExpression: "SET #s = :accepted, acceptedAt = :now, acceptedBy = :uid",
    ExpressionAttributeNames:  { "#s": "status" },
    ExpressionAttributeValues: {
      ":accepted": "ACCEPTED",
      ":now":       now,
      ":uid":       userId,
    },
  }));

  return json(200, { accountId, role: "member", pages });
}

/* ── Router ──────────────────────────────────────────────────── */

exports.handler = async function(event) {
  try {
    const method = getMethod(event);
    const path   = getPath(event);

    // OPTIONS pre-flight
    if (method === "OPTIONS") return json(200, {});

    // /invites/:inviteId/accept (no account context needed)
    if (method === "POST" && /^\/invites\/[^/]+\/accept$/.test(path)) {
      return await acceptInvite(event);
    }

    // /accounts/:accountId/members/:memberId
    if (/^\/accounts\/[^/]+\/members\/[^/]+$/.test(path)) {
      if (method === "PATCH")  return await updateMember(event);
      if (method === "DELETE") return await removeMember(event);
    }

    // /accounts/:accountId/members
    if (/^\/accounts\/[^/]+\/members$/.test(path)) {
      if (method === "GET") return await listMembers(event);
    }

    // /accounts/:accountId/invites/:emailEncoded
    if (/^\/accounts\/[^/]+\/invites\/[^/]+$/.test(path)) {
      if (method === "DELETE") return await revokeInvite(event);
    }

    // /accounts/:accountId/invites
    if (/^\/accounts\/[^/]+\/invites$/.test(path)) {
      if (method === "GET")  return await listInvites(event);
      if (method === "POST") return await createInvite(event);
    }

    // /accounts/:accountId
    if (/^\/accounts\/[^/]+$/.test(path)) {
      if (method === "PATCH")  return await updateAccount(event);
      if (method === "DELETE") return await deleteAccount(event);
    }

    // /accounts
    if (path === "/accounts") {
      if (method === "GET")  return await listAccounts(event);
      if (method === "POST") return await createAccount(event);
    }

    return json(404, { message: "Route not found" });

  } catch (err) {
    console.error("AccountsApi error:", err);
    const status = err.statusCode || 500;
    return json(status, { message: err.message || "Internal server error", errorType: err.name });
  }
};
