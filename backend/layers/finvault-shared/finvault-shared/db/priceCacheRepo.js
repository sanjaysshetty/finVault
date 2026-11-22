"use strict";

/**
 * Repository for PriceCache-<stack> — single consumer (PricesFunction),
 * a 60s application-level TTL cache on top of DynamoDB's own 1hr TTL cleanup.
 * Matches the existing getCachedPrices/setCachedPrices behavior exactly.
 */

const { GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { doc } = require("./client");

const PRICE_CACHE_TTL_MS = 60_000;

function tableName() {
  return process.env.PRICE_CACHE_TABLE;
}

async function getCachedPrices(cacheKey) {
  const table = tableName();
  if (!table) return null;
  try {
    const resp = await doc.send(new GetCommand({ TableName: table, Key: { cacheKey } }));
    const item = resp.Item;
    if (!item?.cachedAt) return null;
    const age = Date.now() - new Date(item.cachedAt).getTime();
    return age < PRICE_CACHE_TTL_MS ? item.data : null;
  } catch {
    return null;
  }
}

async function setCachedPrices(cacheKey, data) {
  const table = tableName();
  if (!table) return;
  try {
    const now = new Date();
    await doc.send(
      new PutCommand({
        TableName: table,
        Item: {
          cacheKey,
          data,
          cachedAt: now.toISOString(),
          ttl: Math.floor(now.getTime() / 1000) + 3600,
        },
      })
    );
  } catch {
    // best-effort cache write — a failure here shouldn't fail the request
  }
}

module.exports = { getCachedPrices, setCachedPrices };
