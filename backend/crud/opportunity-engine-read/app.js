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
 *
 * Recency-prompt fix (Part 7, revised after 2026-10-28 feedback): the
 * trigger route checks a ROLLING 7-day window from the most recent
 * COMPLETE scan (not a calendar-week reset) and, if inside it, does NOT
 * silently refuse -- it returns a "needs_confirmation" response the
 * frontend turns into an explicit "a scan completed N days ago, run
 * again anyway?" prompt. Only a POST with `{ force: true }` in the body
 * (i.e. the user said yes) actually proceeds past that point. An
 * in-progress scan is still refused unconditionally -- that one was
 * never a "do you want to" question. This route's own check-then-invoke
 * is a courtesy, not atomic against two genuinely concurrent clicks;
 * the Python handler's own try_claim_job is the real race-safe gate for
 * that, kept separate from this recency/confirmation logic entirely.
 */

const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const { resolveContext, assertRead } = require("finvault-shared/resolveContext");
const {
  listRecommendations,
  getRecommendationWithHistory,
  getMostRecentScanRun,
} = require("finvault-shared/db/agentRecommendationsRepo");

const lambda = new LambdaClient({});

const OPPORTUNITY_ENGINE_FUNCTION = process.env.OPPORTUNITY_ENGINE_FUNCTION || "";
const RECENCY_PROMPT_WINDOW_DAYS = 7;

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

/**
 * Pure decision function, extracted specifically so the date-boundary
 * cases (same-day, exactly-7-days, just-over-7-days) are directly
 * unit-testable rather than trusted inline inside the route handler.
 * `now` is injectable for tests; defaults to the real current time.
 */
function decideTriggerAction(mostRecentScanRun, force, now = new Date()) {
  if (mostRecentScanRun?.status === "IN_PROGRESS") {
    return { status: "in_progress", message: "A scan is already running — check back shortly." };
  }

  if (mostRecentScanRun?.status === "COMPLETE" && mostRecentScanRun.completedAt && !force) {
    const daysSinceLastScan = Math.floor((now.getTime() - new Date(mostRecentScanRun.completedAt).getTime()) / 86400000);
    if (daysSinceLastScan < RECENCY_PROMPT_WINDOW_DAYS) {
      return {
        status: "needs_confirmation",
        daysSinceLastScan,
        lastScanAt: mostRecentScanRun.completedAt,
        message:
          daysSinceLastScan <= 0
            ? "A scan completed earlier today. Run another one anyway?"
            : `A scan completed ${daysSinceLastScan} day${daysSinceLastScan === 1 ? "" : "s"} ago. Run another one anyway?`,
      };
    }
  }

  return { status: "proceed" };
}

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

      const body = parseBody(event);
      const force = body?.force === true;

      const mostRecent = await getMostRecentScanRun(ctx.accountId);
      const decision = decideTriggerAction(mostRecent, force);

      if (decision.status === "in_progress") {
        return json(202, decision);
      }
      if (decision.status === "needs_confirmation") {
        return json(200, decision);
      }

      await lambda.send(new InvokeCommand({
        FunctionName: OPPORTUNITY_ENGINE_FUNCTION,
        InvocationType: "Event",
        Payload: JSON.stringify({ source: "manual-trigger", accountId: ctx.accountId }),
      }));
      return json(202, { status: "triggered", message: "Scan triggered. Check back in a few minutes." });
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

// Exported alongside the handler for direct verification of the
// date-boundary decision logic (no test framework in this repo --
// see the manual verification notes in the cost-guardrails PR).
exports.decideTriggerAction = decideTriggerAction;
