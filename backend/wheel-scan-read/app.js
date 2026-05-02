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

const { S3Client, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
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

    // Each account has its own isolated scan history under WheelReports/{accountId}/.
    // Owner and all members of the same account share the same prefix.
    const prefix = WHEEL_PREFIX + ctx.accountId + "/";

    // ── GET /wheel/scan/history ──────────────────────────────
    if (method === "GET" && rawPath.endsWith("/wheel/scan/history")) {
      // Cutoff: only include scans within the last month
      const oneMonthAgo = new Date();
      oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
      const cutoff = oneMonthAgo.toISOString().slice(0, 10);

      // 1. List all YYYY-MM-DD.json files actually present in S3 within the cutoff
      const DATE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
      const listedIds = new Set();
      let continuationToken;
      do {
        const listCmd = new ListObjectsV2Command({
          Bucket: ANALYTICS_BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        });
        const listRes = await s3.send(listCmd);
        for (const obj of (listRes.Contents || [])) {
          const filename = obj.Key.slice(prefix.length);
          const m = DATE_RE.exec(filename);
          if (m && m[1] >= cutoff) listedIds.add(m[1]);
        }
        continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
      } while (continuationToken);

      // 2. Load index.json for pre-computed summary metadata
      let indexedScans = [];
      try {
        const indexData = await readS3Json(prefix + "index.json");
        indexedScans = (indexData.scans || []).filter(s => s.scan_id >= cutoff);
      } catch (e) {
        if (e.name !== "NoSuchKey" && e.$metadata?.httpStatusCode !== 404) throw e;
      }
      const indexedById = Object.fromEntries(indexedScans.map(s => [s.scan_id, s]));

      // 3. For any S3 file not in index, read it to extract summary fields
      const missingIds = [...listedIds].filter(id => !indexedById[id]);
      const backfilled = await Promise.all(missingIds.map(async (id) => {
        try {
          const report = await readS3Json(prefix + id + ".json");
          return {
            scan_id:       report.scan_id       || id,
            scan_date:     report.scan_date      || id,
            completed_at:  report.completed_at   || null,
            universe_size: report.universe_size  ?? null,
            proceed_count: report.proceed_count  ?? null,
            watch_count:   report.watch_count    ?? null,
            skip_count:    report.skip_count     ?? null,
            duration_s:    report.duration_s     ?? null,
          };
        } catch {
          return null;
        }
      }));

      // 4. Merge, deduplicate, sort newest-first
      const merged = [
        ...indexedScans,
        ...backfilled.filter(Boolean).filter(s => !indexedById[s.scan_id]),
      ].sort((a, b) => b.scan_id.localeCompare(a.scan_id));

      return json(200, { scans: merged });
    }

    // ── GET /wheel/scan/latest ───────────────────────────────
    if (method === "GET" && rawPath.endsWith("/wheel/scan/latest")) {
      try {
        const data = await readS3Json(prefix + "latest.json");
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
        const data = await readS3Json(prefix + scanId + ".json");
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
