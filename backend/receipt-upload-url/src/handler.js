const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { resolveContext, assertWrite } = require("finvault-shared/resolveContext");

const s3 = new S3Client({});

function json(statusCode, bodyObj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type,authorization",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      ...extraHeaders,
    },
    body: JSON.stringify(bodyObj),
  };
}

function sanitizeFilename(name) {
  return String(name || "upload")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

function isAllowedContentType(ct) {
  if (!ct) return false;
  if (ct === "application/pdf") return true;
  if (ct === "text/csv") return true;
  if (ct.startsWith("image/")) return true;
  return false;
}

function extFromContentType(ct, fallbackName) {
  if (ct === "application/pdf") return ".pdf";
  if (ct === "text/csv") return ".csv";
  if (ct === "image/jpeg") return ".jpg";
  if (ct === "image/png") return ".png";
  if (ct === "image/webp") return ".webp";
  const m = String(fallbackName || "").match(/(\.[a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : "";
}

exports.handler = async (event) => {
  if (event?.requestContext?.http?.method === "OPTIONS") {
    return json(200, { ok: true });
  }

  try {
    const ctx = await resolveContext(event);
    assertWrite(ctx, "receiptsLedger");
    const { accountId, userId } = ctx;

    const bucket = process.env.RECEIPTS_BUCKET || "finvault-receipts-sandbox";
    const prefix = process.env.RECEIPTS_PREFIX || "receipts/";
    const expiresIn = Number(process.env.PRESIGN_EXPIRES_SECONDS || "300");

    let body = event.body;
    if (event.isBase64Encoded) body = Buffer.from(event.body, "base64").toString("utf-8");
    const parsed = body ? JSON.parse(body) : {};

    const contentType = String(parsed.contentType || "").trim();
    const filename = sanitizeFilename(parsed.filename || "upload");

    if (!isAllowedContentType(contentType)) {
      return json(400, { error: `Unsupported contentType: ${contentType}` });
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const rand = crypto.randomBytes(6).toString("hex");
    const ext = extFromContentType(contentType, filename) || "";

    // Scope uploads by accountId so shared-account members land in the same
    // ledger prefix as the owner (not the per-user Cognito sub).
    // receipts/<accountId>/<timestamp>-<rand>.<ext>
    const key = `${prefix}${accountId}/${ts}-${rand}${ext}`;

    const cmd = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      Metadata: {
        // receipt-extractor reads "userid" as the ledger owner key — it must be
        // accountId to match the shim pattern used everywhere else (DDB "userId"
        // attribute actually stores accountId).
        userid: accountId,
        uploaderid: userId,
      },
    });

    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn });

    return json(200, { uploadUrl, key, bucket, expiresIn, contentType });
  } catch (err) {
    if (err?.statusCode === 401) return json(401, { error: "Unauthorized" });
    if (err?.statusCode === 403) return json(403, { error: err.message || "Forbidden" });
    console.error("upload-url error:", err);
    return json(500, { error: "Failed to create presigned url", detail: String(err?.message || err) });
  }
};
