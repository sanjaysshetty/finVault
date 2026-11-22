"use strict";

/**
 * The one shared DynamoDB client for every Node Lambda in this app.
 *
 * Every table-scoped repo in this directory, and any handler that needs to
 * talk to a table with no repo of its own, should import `doc` from here
 * instead of constructing its own DynamoDBDocumentClient. This is the single
 * place to change client-wide config — region, marshalling defaults, retry/
 * backoff behavior, future SDK major-version bumps — without touching every
 * function that happens to talk to DynamoDB.
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

module.exports = { doc };
