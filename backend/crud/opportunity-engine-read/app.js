"use strict";

/**
 * OpportunityEngineReadFunction
 * Serves Opportunity Engine recommendations from AgentRecommendationsTable
 * and triggers scans. Mirrors wheel-scan-read's split (lightweight sync
 * API Lambda in front of the heavy async Python worker) for the same
 * reason — a full scan takes minutes, far past API Gateway's 29s timeout.
 *
 * Routes:
 *   GET  /research/opportunities                  → list recommendations for the account
 *   GET  /research/opportunities/{recommendationId} → one recommendation + scenario-run history
 *   POST /research/opportunities/trigger           → async-invoke OpportunityEngineFunction
 */

const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const { resolveContext, assertRead } = require("finvault-shared/resolveContext");
const {
  listRecommendations,
  getRecommendationWithHistory,
} = require("finvault-shared/db/agentRecommendationsRepo");

const lambda = new LambdaClient({});

const OPPORTUNITY_ENGINE_FUNCTION = process.env.OPPORTUNITY_ENGINE_FUNCTION || "";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Account-Id",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
}

function json(statusCode, body) {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  const method = (event.requestContext?.http?.method || event.httpMethod || "GET").toUpperCase();
  const rawPath = event.rawPath || event.path || "/";

  if (method === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };

  try {
    const ctx = await resolveContext(event);
    assertRead(ctx, "opportunityEngine");

    // ── POST /research/opportunities/trigger ──────────────────
    if (method === "POST" && rawPath.endsWith("/research/opportunities/trigger")) {
      if (!OPPORTUNITY_ENGINE_FUNCTION) {
        return json(503, { error: "Scan function not configured" });
      }
      await lambda.send(new InvokeCommand({
        FunctionName: OPPORTUNITY_ENGINE_FUNCTION,
        InvocationType: "Event",
        Payload: JSON.stringify({ source: "manual-trigger", accountId: ctx.accountId }),
      }));
      return json(202, { message: "Scan triggered. Check back in a few minutes." });
    }

    // ── GET /research/opportunities ────────────────────────────
    if (method === "GET" && rawPath.endsWith("/research/opportunities")) {
      const items = await listRecommendations(ctx.accountId);
      return json(200, { recommendations: items });
    }

    // ── GET /research/opportunities/{recommendationId} ────────
    if (method === "GET") {
      const parts = rawPath.split("/").filter(Boolean);
      const recommendationId = parts[parts.length - 1];
      if (!recommendationId) {
        return json(400, { error: "recommendationId required" });
      }
      const { header, scenarioRuns } = await getRecommendationWithHistory(ctx.accountId, recommendationId);
      if (!header) {
        return json(404, { error: `Recommendation ${recommendationId} not found` });
      }
      return json(200, { recommendation: header, scenarioRuns });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    if (err.statusCode === 401) return json(401, { error: "Unauthorized" });
    if (err.statusCode === 403) return json(403, { error: err.message });
    console.error("OpportunityEngineRead error:", err);
    return json(500, { error: "Internal server error" });
  }
};
