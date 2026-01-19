const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({});

function guessContentType(key) {
  const k = String(key || "").toLowerCase();
  if (k.endsWith(".html")) return "text/html; charset=utf-8";
  if (k.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (k.endsWith(".css")) return "text/css; charset=utf-8";
  if (k.endsWith(".json")) return "application/json; charset=utf-8";
  if (k.endsWith(".svg")) return "image/svg+xml";
  if (k.endsWith(".png")) return "image/png";
  if (k.endsWith(".jpg") || k.endsWith(".jpeg")) return "image/jpeg";
  if (k.endsWith(".webp")) return "image/webp";
  if (k.endsWith(".ico")) return "image/x-icon";
  if (k.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (k.endsWith(".map")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function isBinaryContentType(ct) {
  return (
    ct.startsWith("image/") ||
    ct === "application/octet-stream" ||
    ct === "application/pdf" ||
    ct === "image/x-icon"
  );
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

function normalizePath(p) {
  p = String(p || "");
  return p.replace(/^\/+/, "");
}

exports.handler = async (event) => {
  const bucket = process.env.FRONTEND_BUCKET;
  const prefix = process.env.FRONTEND_PREFIX || "app/";

  if (!bucket) return { statusCode: 500, body: "Missing FRONTEND_BUCKET env var" };

  const rawPath = event?.rawPath || "/";
  const path = normalizePath(rawPath);

  // Only serve under /app
  if (!path.startsWith("app")) return { statusCode: 404, body: "Not Found" };

  let key = path;

  // /app or /app/ => index.html
  if (key === "app" || key === "app/") key = "app/index.html";
  if (key.endsWith("/")) key += "index.html";

  let obj;
  try {
    obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (e) {
    // SPA fallback: if no extension, serve index.html
    const looksLikeAsset = /\.[a-z0-9]+$/i.test(key);
    if (!looksLikeAsset) {
      try {
        key = "app/index.html";
        obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      } catch {
        return { statusCode: 404, body: "index.html not found in S3" };
      }
    } else {
      return { statusCode: 404, body: "File not found" };
    }
  }

  const contentType = obj.ContentType || guessContentType(key);
  const buf = await streamToBuffer(obj.Body);

  const isIndex = key.endsWith("index.html");
  const cacheControl = isIndex
    ? "no-store, no-cache, must-revalidate"
    : "public, max-age=31536000, immutable";

  const headers = {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
  };

  if (isBinaryContentType(contentType)) {
    return {
      statusCode: 200,
      headers,
      isBase64Encoded: true,
      body: buf.toString("base64"),
    };
  }

  return { statusCode: 200, headers, body: buf.toString("utf-8") };
};
