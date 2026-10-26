"use strict";

/**
 * DeepDiveApi — lightweight sync front door for Deep Dive & Scenarios.
 *
 * Mirrors advisor-api's existing 202+poll pattern exactly (reuses
 * AdvisorCacheTable via the same advisorCacheRepo — no new cache table;
 * a generic cacheKey->value TTL cache doesn't need a second copy just
 * because the capability it's serving is new). The actual AgentLoop work
 * — the part of "port Advisor to Python" that actually matters — lives
 * in DeepDiveWorkerFunction (Python), invoked async from here.
 *
 * Routes:
 *   POST /research/deep-dive/chat              → check cache, else fire worker, 202 {jobId}
 *   GET  /research/deep-dive/result/{cacheKey} → poll
 */

const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const crypto = require("crypto");
const { json, badRequest } = require("finvault-shared/http");
const { resolveContext, assertRead } = require("finvault-shared/resolveContext");
const { readCache } = require("finvault-shared/db/advisorCacheRepo");

const lambda = new LambdaClient({});

const DEEP_DIVE_WORKER_FUNCTION = process.env.DEEP_DIVE_WORKER_FUNCTION || "";

function buildCacheKey(accountId, message, history, recommendationId) {
  const payload = JSON.stringify({
    accountId,
    message: String(message).trim(),
    historyLen: (history || []).length,
    recommendationId: recommendationId || null,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  const path = event.rawPath || event.path || "";

  // API Gateway's CorsConfiguration handles real preflights before this
  // Lambda is ever invoked (per CLAUDE.md -- no Method: OPTIONS route is
  // registered for this function); this branch is defensive only.
  if (method === "OPTIONS") return json(204, {});

  try {
    const ctx = await resolveContext(event);
    assertRead(ctx, "deepDive");

    /* ── GET /research/deep-dive/result/:cacheKey ──────────────── */
    if (method === "GET" && path.includes("/research/deep-dive/result/")) {
      const cacheKey = path.split("/research/deep-dive/result/")[1]?.trim();
      if (!cacheKey) return badRequest("cacheKey is required");

      const item = await readCache(cacheKey);
      if (!item || item.status === "IN_PROGRESS") {
        return json(404, { status: "pending", message: "Not ready yet" });
      }
      if (item.workerError) {
        return json(500, { error: true, message: item.errorMessage, cacheKey });
      }
      return json(200, {
        reply: item.reply,
        cacheKey,
        cached: true,
        recommendationId: item.recommendationId || null,
        approved: item.approved || null,
      });
    }

    /* ── POST /research/deep-dive/chat ──────────────────────────── */
    if (method === "POST" && path.endsWith("/research/deep-dive/chat")) {
      const body = event.body
        ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body)
        : {};
      const { message, history = [], recommendationId } = body;
      if (!message || !String(message).trim()) return badRequest("message is required");

      const cacheKey = buildCacheKey(ctx.accountId, message, history, recommendationId);

      const cached = await readCache(cacheKey);
      if (cached && cached.status !== "IN_PROGRESS") {
        if (cached.workerError) {
          return json(500, { error: true, message: cached.errorMessage, cacheKey });
        }
        return json(200, {
          reply: cached.reply,
          cacheKey,
          cached: true,
          recommendationId: cached.recommendationId || null,
          approved: cached.approved || null,
        });
      }
      if (cached && cached.status === "IN_PROGRESS") {
        // Already running (e.g. a duplicate submit) -- don't fire a second worker.
        return json(202, { jobId: cacheKey, status: "pending" });
      }

      if (!DEEP_DIVE_WORKER_FUNCTION) {
        return json(503, { error: "Worker function not configured" });
      }
      await lambda.send(new InvokeCommand({
        FunctionName: DEEP_DIVE_WORKER_FUNCTION,
        InvocationType: "Event",
        Payload: JSON.stringify({ cacheKey, accountId: ctx.accountId, message, history, recommendationId }),
      }));

      return json(202, { jobId: cacheKey, status: "pending" });
    }

    return json(404, { message: "Not found" });
  } catch (err) {
    if (err.statusCode === 401) return json(401, { error: "Unauthorized" });
    if (err.statusCode === 403) return json(403, { error: err.message });
    console.error("DeepDiveApi error:", err);
    return json(500, { error: "Internal server error" });
  }
};
