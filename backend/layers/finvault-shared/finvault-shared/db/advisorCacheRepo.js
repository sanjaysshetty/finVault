"use strict";

/**
 * Repository for AdvisorCache-<stack> — single consumer (advisor-api),
 * a 30-minute TTL cache keyed by a hash of the request. Matches the
 * existing readCache/writeCache behavior exactly.
 */

const { GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { doc } = require("./client");

function tableName() {
  return process.env.ADVISOR_CACHE_TABLE;
}

async function readCache(cacheKey) {
  const table = tableName();
  if (!table) return null;
  try {
    const res = await doc.send(new GetCommand({ TableName: table, Key: { cacheKey } }));
    return res.Item || null;
  } catch {
    return null;
  }
}

async function writeCache(cacheKey, data) {
  const table = tableName();
  if (!table) return;
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
  try {
    await doc.send(
      new PutCommand({
        TableName: table,
        Item: { cacheKey, ...data, expiresAt, updatedAt: new Date().toISOString() },
      })
    );
  } catch (e) {
    console.error(JSON.stringify({ level: "WARN", event: "cache_write_failed", error: e.message }));
  }
}

module.exports = { readCache, writeCache };
