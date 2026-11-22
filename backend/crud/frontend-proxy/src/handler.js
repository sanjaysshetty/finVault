// FrontendProxyFunction - full replacement
// Serves a Vite/React SPA stored in S3 under a prefix (default: "app/") behind API Gateway HTTP API routes:
//   GET /app
//   GET /app/{proxy+}
//
// Expected S3 layout (matches your screenshot):
//   s3://<FRONTEND_BUCKET>/app/index.html
//   s3://<FRONTEND_BUCKET>/app/assets/...
//
// Required env:
//   FRONTEND_BUCKET = your bucket name
// Optional env:
//   FRONTEND_PREFIX = "app" (or "app/")  <-- recommended to set to "app"

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
  if (k.endsWith(".woff")) return "font/woff";
  if (k.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function isBinaryContentType(ct) {
  const c = String(ct || "").toLowerCase();
  return (
    c.startsWith("image/") ||
    c === "application/octet-stream" ||
    c === "application/pdf" ||
    c === "image/x-icon" ||
    c.startsWith("font/")
  );
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

function normalizePath(p) {
  return String(p || "").replace(/^\/+/, "");
}

function normalizePrefix(pfx) {
  // "app", "/app", "app/", "/app/" -> "app/"
  const cleaned = String(pfx || "app").replace(/^\/+|\/+$/g, "");
  return cleaned ? `${cleaned}/` : "";
}

function looksLikeAsset(key) {
  // Has a file extension at the end (e.g. .js .css .png)
  return /\.[a-z0-9]+$/i.test(key);
}

exports.handler = async (event) => {
  const bucket = process.env.FRONTEND_BUCKET;
  const prefix = normalizePrefix(process.env.FRONTEND_PREFIX || "app");

  if (!bucket) {
    return { statusCode: 500, body: "Missing FRONTEND_BUCKET env var" };
  }

  const rawPath = event?.rawPath || "/";
  const path = normalizePath(rawPath);

  // Only serve /app and /app/*
  if (!(path === "app" || path === "app/" || path.startsWith("app/"))) {
    return { statusCode: 404, body: "Not Found" };
  }

  // Map request path to S3 key:
  //   /app or /app/ -> <prefix>index.html
  //   /app/<rest>   -> <prefix><rest>
  let key;
  if (path === "app" || path === "app/") {
    key = `${prefix}index.html`;
  } else {
    const rest = path.slice("app/".length); // remove "app/"
    key = `${prefix}${rest}`;
  }

  // If ends with "/" (folder), serve index.html within that folder
  if (key.endsWith("/")) key += "index.html";

  let obj;
  try {
    obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (e) {
    // SPA fallback:
    // If request doesn't look like a real file (no extension), serve index.html
    if (!looksLikeAsset(key)) {
      try {
        key = `${prefix}index.html`;
        obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      } catch (e2) {
        console.log("FrontendProxy: index.html not found", {
          bucket,
          keyTried: key,
          error: e2?.name || e2,
        });
        return { statusCode: 404, body: "index.html not found in S3" };
      }
    } else {
      // Real asset missing
      console.log("FrontendProxy: asset not found", {
        bucket,
        keyTried: key,
        error: e?.name || e,
      });
      return { statusCode: 404, body: "File not found" };
    }
  }

  const contentType = obj.ContentType || guessContentType(key);
  const buf = await streamToBuffer(obj.Body);

  const isIndex = key.endsWith("index.html");

  // Cache:
  // - index.html: no-cache (so updates propagate)
  // - hashed assets: long cache
  const cacheControl = isIndex
    ? "no-store, no-cache, must-revalidate"
    : "public, max-age=31536000, immutable";

  const headers = {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
  };

  // Optional CORS (usually not needed for same-origin SPA, but harmless):
  // headers["Access-Control-Allow-Origin"] = "*";

  if (isBinaryContentType(contentType)) {
    return {
      statusCode: 200,
      headers,
      isBase64Encoded: true,
      body: buf.toString("base64"),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: buf.toString("utf-8"),
  };
};