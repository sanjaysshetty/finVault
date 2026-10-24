"use strict";

/**
 * PostConfirmationFunction — Cognito Post Confirmation trigger.
 *
 * Fires after a new user confirms their email (sign-up or admin confirmation).
 * Looks up all PENDING invites for the confirmed email and:
 *   1. Creates a FinAccountMembers record for each invited account.
 *   2. Marks each invite as ACCEPTED.
 *
 * IMPORTANT: This trigger MUST always return the event object — throwing an
 * error here would block the user from completing registration.
 * All errors are caught and logged; the event is always returned.
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const INVITES_TABLE = process.env.FIN_ACCOUNT_INVITES_TABLE || "FinAccountInvitesV2";
const MEMBERS_TABLE = process.env.FIN_ACCOUNT_MEMBERS_TABLE || "FinAccountMembers";

exports.handler = async (event) => {
  try {
    const attrs  = event.request?.userAttributes || {};
    const email  = (attrs.email || "").toLowerCase().trim();
    const userId = attrs.sub;

    if (!email || !userId) {
      console.log("PostConfirmation: missing email or sub — skipping invite check");
      return event;
    }

    console.log(`PostConfirmation: checking invites for ${email} (userId=${userId})`);

    // Query all invites for this email from the main table (emailLower is the PK).
    const result = await doc.send(new QueryCommand({
      TableName: INVITES_TABLE,
      KeyConditionExpression:    "emailLower = :email",
      FilterExpression:          "#s = :pending",
      ExpressionAttributeNames:  { "#s": "status" },
      ExpressionAttributeValues: { ":email": email, ":pending": "PENDING" },
    }));

    const invites = result.Items || [];

    if (invites.length === 0) {
      console.log(`PostConfirmation: no pending invites for ${email}`);
      return event;
    }

    console.log(`PostConfirmation: found ${invites.length} pending invite(s) for ${email}`);

    const now = new Date().toISOString();

    await Promise.all(invites.map(async (invite) => {
      const { accountId, pages } = invite;

      // 1. Create member record (idempotent — safe if already exists).
      await doc.send(new PutCommand({
        TableName: MEMBERS_TABLE,
        Item: {
          accountId,
          userId,
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
        console.log(`PostConfirmation: member record already exists for ${userId} → ${accountId}`);
      });

      // 2. Mark invite as ACCEPTED.
      await doc.send(new UpdateCommand({
        TableName: INVITES_TABLE,
        Key: { emailLower: email, accountId },
        UpdateExpression:
          "SET #s = :accepted, acceptedAt = :now, acceptedBy = :uid",
        ExpressionAttributeNames:  { "#s": "status" },
        ExpressionAttributeValues: {
          ":accepted": "ACCEPTED",
          ":now":      now,
          ":uid":      userId,
        },
      }));

      console.log(`PostConfirmation: accepted invite for ${email} → account ${accountId}`);
    }));

  } catch (err) {
    // Never throw from a Cognito trigger — it would block user registration.
    console.error("PostConfirmation: unexpected error during invite acceptance:", err);
  }

  return event;
};
