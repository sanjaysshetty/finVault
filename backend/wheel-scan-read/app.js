"use strict";

/**
 * WheelScanReadFunction
 * Serves Wheel Strategy scan reports from S3 (AnalyticsBucket / WheelReports/).
 *
 * Routes:
 *   GET  /wheel/scan/latest          → WheelReports/latest.json
 *   GET  /wheel/scan/history         → WheelReports/index.json
 *   GET  /wheel/scan/{scanId}        → WheelReports/{scanId}.json
 *   POST /wheel/scan/trigger         → async-invoke WheelScanFunction
 */

const { S3Client, GetObjectCommand }          = require("@aws-sdk/client-s3");
const { LambdaClient, InvokeCommand }         = require("@aws-sdk/client-lambda");
const { resolveContext, assertRead }          = require("finvault-shared/resolveContext");

const s3     = new S3Client({});
const lambda = new LambdaClient({});

const ANALYTICS_BUCKET      = process.env.ANALYTICS_BUCKET      || "";
const WHEEL_PREFIX          = process.env.WHEEL_PREFIX          || "WheelReports/";
const WHEEL_SCAN_FUNCTION   = process.env.WHEEL_SCAN_FUNCTION   || "";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Account-Id",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
}

function json(statusCode, body) {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(body) };
}

async function readS3Json(key) {
  const cmd = new GetObjectCommand({ Bucket: ANALYTICS_BUCKET, Key: key });
  const res = await s3.send(cmd);
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

exports.handler = async (event) => {
  const method   = (event.requestContext?.http?.method || event.httpMethod || "GET").toUpperCase();
  const rawPath  = event.rawPath || event.path || "/";

  // OPTIONS preflight
  if (method === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };

  try {
    // Auth
    const ctx = await resolveContext(event);
    assertRead(ctx, "wheelScan");

    // ── GET /wheel/scan/history ──────────────────────────────
    if (method === "GET" && rawPath.endsWith("/wheel/scan/history")) {
      try {
        const data = await readS3Json(WHEEL_PREFIX + "index.json");
        return json(200, data);
      } catch (e) {
        if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) {
          return json(200, { scans: [] });
        }
        throw e;
      }
    }

    // ── GET /wheel/scan/latest ───────────────────────────────
    if (method === "GET" && rawPath.endsWith("/wheel/scan/latest")) {
      try {
        const data = await readS3Json(WHEEL_PREFIX + "latest.json");
        return json(200, data);
      } catch (e) {
        if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) {
          return json(404, { error: "No scan available yet" });
        }
        throw e;
      }
    }

    // ── POST /wheel/scan/trigger ─────────────────────────────
    if (method === "POST" && rawPath.endsWith("/wheel/scan/trigger")) {
      if (!WHEEL_SCAN_FUNCTION) {
        return json(503, { error: "Scan function not configured" });
      }
      // Async invoke — fire and forget
      await lambda.send(new InvokeCommand({
        FunctionName:   WHEEL_SCAN_FUNCTION,
        InvocationType: "Event",
        Payload:        JSON.stringify({ source: "manual-trigger", accountId: ctx.accountId }),
      }));
      return json(202, { message: "Scan triggered. Check back in 5–10 minutes." });
    }

    // ── GET /wheel/scan/{scanId} ─────────────────────────────
    if (method === "GET") {
      const parts  = rawPath.split("/").filter(Boolean);
      const scanId = parts[parts.length - 1];  // last path segment

      // Validate scanId format: YYYY-MM-DD
      if (!/^\d{4}-\d{2}-\d{2}$/.test(scanId)) {
        return json(400, { error: "Invalid scanId format. Expected YYYY-MM-DD." });
      }

      try {
        const data = await readS3Json(WHEEL_PREFIX + scanId + ".json");
        return json(200, data);
      } catch (e) {
        if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) {
          return json(404, { error: `Scan ${scanId} not found` });
        }
        throw e;
      }
    }

    return json(405, { error: "Method not allowed" });

  } catch (err) {
    if (err.statusCode === 401) return json(401, { error: "Unauthorized" });
    if (err.statusCode === 403) return json(403, { error: err.message });
    console.error("WheelScanRead error:", err);
    return json(500, { error: "Internal server error" });
  }
};
