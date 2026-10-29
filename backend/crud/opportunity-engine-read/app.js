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
 * Cost-guardrail fix (Part 7, after the 2026-10-26 incident): the trigger
 * route now pre-checks for an already-completed scan this ISO week
 * before invoking the Lambda at all, so a re-click (or anyone re-POSTing)
 * doesn't fire a second full-cost scan. This is a courtesy pre-check, not
 * the authoritative guard -- it isn't atomic against two genuinely
 * concurrent clicks. The Python handler's own try_claim_job is the real
 * race-safe gate; this just avoids even invoking the Lambda in the
 * common case.
 */

const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const { resolveContext, assertRead } = require("finvault-shared/resolveContext");
const {
  listRecommendations,
  getRecommendationWithHistory,
  getScanRunForWeek,
} = require("finvault-shared/db/agentRecommendationsRepo");

const lambda = new LambdaClient({});

const OPPORTUNITY_ENGINE_FUNCTION = process.env.OPPORTUNITY_ENGINE_FUNCTION || "";

/**
 * ISO 8601 year-week key, e.g. "2026-W44". Must match the Python handler's
 * _scan_week_key() exactly (both implement the same ISO week-numbering
 * rule, including the year-boundary edge case where late December can
 * belong to week 1 of the following ISO year) -- verified against
 * Python's date.isocalendar() across every such edge case before use,
 * not assumed.
 */
function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayOfWeek = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek); // move to Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${isoYear}-W${String(isoWeek).padStart(2, "0")}`;
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

      const weekKey = isoWeekKey();
      const existingScanRun = await getScanRunForWeek(ctx.accountId, weekKey);
      if (existingScanRun?.status === "COMPLETE") {
        return json(200, {
          status: "already_scanned",
          weekKey,
          message: `This week's scan (${weekKey}) already completed — see existing recommendations.`,
          scanRun: existingScanRun,
        });
      }
      if (existingScanRun?.status === "IN_PROGRESS") {
        return json(202, { status: "in_progress", weekKey, message: "This week's scan is already running — check back shortly." });
      }

      await lambda.send(new InvokeCommand({
        FunctionName: OPPORTUNITY_ENGINE_FUNCTION,
        InvocationType: "Event",
        Payload: JSON.stringify({ source: "manual-trigger", accountId: ctx.accountId }),
      }));
      return json(202, { status: "triggered", weekKey, message: "Scan triggered. Check back in a few minutes." });
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
