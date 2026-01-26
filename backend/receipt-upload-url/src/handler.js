const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

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
  if (ct.startsWith("image/")) return true;
  return false;
}

function extFromContentType(ct, fallbackName) {
  if (ct === "application/pdf") return ".pdf";
  if (ct === "image/jpeg") return ".jpg";
  if (ct === "image/png") return ".png";
  if (ct === "image/webp") return ".webp";
  const m = String(fallbackName || "").match(/(\.[a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : "";
}

function getUserIdFromJwt(event) {
  // HTTP API JWT authorizer
  const claims = event?.requestContext?.authorizer?.jwt?.claims || {};
  // Prefer sub; fallback to username
  return claims.sub || claims["cognito:username"] || "";
}

exports.handler = async (event) => {
  if (event?.requestContext?.http?.method === "OPTIONS") {
    return json(200, { ok: true });
  }

  try {
    const userId = getUserIdFromJwt(event);
    if (!userId) return json(401, { error: "Unauthorized" });

    const bucket = process.env.RECEIPTS_BUCKET || "finapp-receipts-1152";
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

    // ✅ Put userId into key path (easiest + efficient)
    // receipts/<userId>/<timestamp>-<rand>.<ext>
    const key = `${prefix}${userId}/${ts}-${rand}${ext}`;

    const cmd = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      // ✅ userId metadata (also useful if you later change key scheme)
      Metadata: {
        userid: userId,
      },
    });

    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn });

    return json(200, { uploadUrl, key, bucket, expiresIn, contentType });
  } catch (err) {
    console.error("upload-url error:", err);
    return json(500, { error: "Failed to create presigned url", detail: String(err?.message || err) });
  }
};
