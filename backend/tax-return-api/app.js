"use strict";

const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { resolveContext, assertRead, assertWrite } = require("finvault-shared/resolveContext");
const { putItem, getItem, deleteItem, queryByGSI1 } = require("finvault-shared/ddb");
const { json, badRequest, notFound } = require("finvault-shared/http");

const TAX_DOCS_BUCKET = process.env.TAX_DOCS_BUCKET || "";
const s3 = TAX_DOCS_BUCKET
  ? new S3Client({ region: process.env.AWS_REGION || "us-east-1" })
  : null;

function pickId() {
  return `tdoc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseBody(event) {
  try { return typeof event.body === "string" ? JSON.parse(event.body) : (event.body || {}); }
  catch { return null; }
}

function currentYear() { return new Date().getFullYear(); }

// GET /tax-return?year=2026
async function listDocuments(event, ctx) {
  assertRead(ctx, "taxReturn");
  const year = String(event.queryStringParameters?.year || currentYear());
  const [items, config] = await Promise.all([
    queryByGSI1(ctx.accountId, `TAX_DOC#${year}#`),
    getItem(ctx.accountId, `TAX_CFG#${year}`),
  ]);
  return json(200, { items, config: config || null });
}

// POST /tax-return/config  — stores all config fields sent by the frontend
async function saveConfig(event, ctx) {
  assertWrite(ctx, "taxReturn");
  const body = parseBody(event);
  if (!body) return badRequest("Invalid JSON");
  const year = String(body.year || currentYear());
  // Reserved DDB fields not allowed to be overwritten from body
  const RESERVED = new Set(["userId", "assetId", "gsi1pk", "gsi1sk", "taxYear", "updatedAt"]);
  const extras = Object.fromEntries(
    Object.entries(body).filter(([k]) => !RESERVED.has(k) && k !== "year")
  );
  const item = {
    userId:    ctx.accountId,
    assetId:   `TAX_CFG#${year}`,
    gsi1pk:    ctx.accountId,
    gsi1sk:    `TAX_CFG#${year}`,
    taxYear:   Number(year),
    ...extras,
    updatedAt: new Date().toISOString(),
  };
  await putItem(item);
  return json(200, item);
}

// POST /tax-return/documents
async function createDocument(event, ctx) {
  assertWrite(ctx, "taxReturn");
  const body = parseBody(event);
  if (!body) return badRequest("Invalid JSON");
  const year  = String(body.taxYear || currentYear());
  // Accept caller-supplied docId so the S3 key (from upload-url) matches this record.
  const docId = body.docId || pickId();
  const now   = new Date().toISOString();
  const item  = {
    userId:    ctx.accountId,
    assetId:   `TAX_DOC#${year}#${docId}`,
    gsi1pk:    ctx.accountId,
    gsi1sk:    `TAX_DOC#${year}#${docId}`,
    docId,
    docType:   String(body.docType  || ""),
    taxYear:   Number(year),
    person:    String(body.person   || "self"),
    label:     String(body.label    || ""),
    data:      body.data            || {},
    status:    "manual",
    createdAt: now,
    updatedAt: now,
  };
  if (body.period != null) item.period = String(body.period);
  await putItem(item);
  return json(201, item);
}

// PUT /tax-return/documents/{docId}
async function updateDocument(event, ctx, docId) {
  assertWrite(ctx, "taxReturn");
  const body = parseBody(event);
  if (!body) return badRequest("Invalid JSON");
  const year = String(body.taxYear || event.queryStringParameters?.year || currentYear());
  const existing = await getItem(ctx.accountId, `TAX_DOC#${year}#${docId}`);
  if (!existing) return notFound();
  const updated = {
    ...existing,
    label:     body.label  !== undefined ? String(body.label)  : existing.label,
    person:    body.person !== undefined ? String(body.person) : existing.person,
    data:      body.data   !== undefined ? body.data           : existing.data,
    updatedAt: new Date().toISOString(),
  };
  if (body.period != null) updated.period = String(body.period);
  await putItem(updated);
  return json(200, updated);
}

// DELETE /tax-return/documents/{docId}?year=2026
async function deleteDocument(event, ctx, docId) {
  assertWrite(ctx, "taxReturn");
  const year = String(event.queryStringParameters?.year || currentYear());
  const existing = await getItem(ctx.accountId, `TAX_DOC#${year}#${docId}`);
  if (!existing) return notFound();
  await deleteItem(ctx.accountId, `TAX_DOC#${year}#${docId}`);
  return json(200, { deleted: true });
}

// POST /tax-return/documents/upload-url  — returns a presigned S3 PUT URL (15 min)
async function createUploadUrl(event, ctx) {
  assertWrite(ctx, "taxReturn");
  if (!s3 || !TAX_DOCS_BUCKET) return badRequest("File upload not configured");
  const body = parseBody(event);
  if (!body) return badRequest("Invalid JSON");
  const year        = String(body.year || currentYear());
  const docId       = body.docId || pickId();
  const fileName    = String(body.fileName || "document.pdf").replace(/[^a-zA-Z0-9._-]/g, "_");
  const contentType = String(body.contentType || "application/pdf");
  const s3Key       = `${ctx.accountId}/${year}/${docId}/${fileName}`;
  const cmd         = new PutObjectCommand({ Bucket: TAX_DOCS_BUCKET, Key: s3Key, ContentType: contentType });
  const uploadUrl   = await getSignedUrl(s3, cmd, { expiresIn: 900 });
  return json(200, { uploadUrl, s3Key, docId, fileName });
}

// GET /tax-return/documents/{docId}/download-url?year=2026  — returns a presigned S3 GET URL (5 min)
async function createDownloadUrl(event, ctx, docId) {
  assertRead(ctx, "taxReturn");
  if (!s3 || !TAX_DOCS_BUCKET) return badRequest("File download not configured");
  const year     = String(event.queryStringParameters?.year || currentYear());
  const existing = await getItem(ctx.accountId, `TAX_DOC#${year}#${docId}`);
  if (!existing) return notFound();
  const s3Key = existing.data?.s3Key;
  if (!s3Key)  return notFound();
  const cmd         = new GetObjectCommand({ Bucket: TAX_DOCS_BUCKET, Key: s3Key });
  const downloadUrl = await getSignedUrl(s3, cmd, { expiresIn: 300 });
  return json(200, { downloadUrl, fileName: s3Key.split("/").pop() });
}

exports.handler = async (event) => {
  try {
    const ctx    = await resolveContext(event);
    const method = (event.requestContext?.http?.method || event.httpMethod || "").toUpperCase();
    const path   = event.requestContext?.http?.path   || event.path || "";

    // Exact-path routes first (before regex matching)
    if (path === "/tax-return"                          && method === "GET")  return listDocuments(event, ctx);
    if (path === "/tax-return/config"                   && method === "POST") return saveConfig(event, ctx);
    if (path === "/tax-return/documents"                && method === "POST") return createDocument(event, ctx);
    if (path === "/tax-return/documents/upload-url"     && method === "POST") return createUploadUrl(event, ctx);

    // /tax-return/documents/{docId}
    const docMatch = path.match(/^\/tax-return\/documents\/([^/]+)$/);
    if (docMatch) {
      const docId = decodeURIComponent(docMatch[1]);
      if (method === "PUT")    return updateDocument(event, ctx, docId);
      if (method === "DELETE") return deleteDocument(event, ctx, docId);
    }

    // /tax-return/documents/{docId}/download-url
    const dlMatch = path.match(/^\/tax-return\/documents\/([^/]+)\/download-url$/);
    if (dlMatch) {
      const docId = decodeURIComponent(dlMatch[1]);
      if (method === "GET") return createDownloadUrl(event, ctx, docId);
    }

    return badRequest("Unknown route");
  } catch (e) {
    console.error(e);
    return json(500, { message: e.message, errorType: e.name });
  }
};
