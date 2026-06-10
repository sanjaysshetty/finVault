"use strict";
//
// tax-return-extractor/app.js
//
// S3-triggered Lambda. Fires when a user uploads a tax document to TaxDocsBucket.
// Key format: {accountId}/{year}/{docId}/{filename}
//
// Steps:
//   1. Parse accountId / year / docId from the S3 key
//   2. Look up the DynamoDB record to get docType
//   3. Download the file from S3
//   4. Call Claude Sonnet with docType-specific tool_use schema
//   5. Merge extracted fields into the existing record, set status="extracted"
//
// Required env vars:
//   FIN_ASSETS_TABLE      — finAssets DynamoDB table name
//   ANTHROPIC_API_KEY     — from SSM /finvault/anthropic/api-key
//   ANTHROPIC_MODEL       — defaults to claude-sonnet-4-6

const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const Anthropic = require("@anthropic-ai/sdk");
const { getItem, putItem } = require("finvault-shared/ddb");

const s3     = new S3Client({});
const MODEL  = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

// Lazy-init Anthropic client (API key resolved from env at runtime)
let _anthropic;
function anthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

/* ─── Extraction schemas per docType ───────────────────────── */
const SCHEMAS = {
  PAYSLIP: {
    description: "employee pay stub / paycheck",
    fields: {
      employer:         { type: ["string","null"], description: "Employer name" },
      payPeriodStart:   { type: ["string","null"], description: "Pay period start date YYYY-MM-DD" },
      payPeriodEnd:     { type: ["string","null"], description: "Pay period end date YYYY-MM-DD" },
      grossPay:         { type: ["number","null"], description: "Total gross wages before deductions" },
      federalWithheld:  { type: ["number","null"], description: "Federal income tax withheld" },
      ssWithheld:       { type: ["number","null"], description: "Social Security (OASDI) tax withheld" },
      medicareWithheld: { type: ["number","null"], description: "Medicare tax withheld" },
      stateWithheld:    { type: ["number","null"], description: "State income tax withheld (0 for Texas)" },
    },
    required: ["employer", "grossPay", "federalWithheld"],
  },

  W2: {
    description: "IRS Form W-2 Wage and Tax Statement",
    fields: {
      employer:         { type: ["string","null"], description: "Employer name (Box c)" },
      wages:            { type: ["number","null"], description: "Box 1 — Wages, tips, other compensation" },
      federalWithheld:  { type: ["number","null"], description: "Box 2 — Federal income tax withheld" },
      ssWages:          { type: ["number","null"], description: "Box 3 — Social Security wages" },
      ssWithheld:       { type: ["number","null"], description: "Box 4 — Social Security tax withheld" },
      medicareWages:    { type: ["number","null"], description: "Box 5 — Medicare wages and tips" },
      medicareWithheld: { type: ["number","null"], description: "Box 6 — Medicare tax withheld" },
    },
    required: ["employer", "wages", "federalWithheld"],
  },

  "1099-INT": {
    description: "IRS Form 1099-INT Interest Income",
    fields: {
      payer:           { type: ["string","null"], description: "Payer name (bank or financial institution)" },
      interestIncome:  { type: ["number","null"], description: "Box 1 — Interest income" },
      federalWithheld: { type: ["number","null"], description: "Box 4 — Federal income tax withheld (often 0)" },
    },
    required: ["payer", "interestIncome"],
  },

  "1099-DIV": {
    description: "IRS Form 1099-DIV Dividends and Distributions",
    fields: {
      payer:              { type: ["string","null"], description: "Payer name (brokerage or fund)" },
      ordinaryDividends:  { type: ["number","null"], description: "Box 1a — Total ordinary dividends" },
      qualifiedDividends: { type: ["number","null"], description: "Box 1b — Qualified dividends (subset of ordinary)" },
      federalWithheld:    { type: ["number","null"], description: "Box 4 — Federal income tax withheld" },
    },
    required: ["payer", "ordinaryDividends", "qualifiedDividends"],
  },

  "1099-B": {
    description: "IRS Form 1099-B Proceeds from Broker and Barter Exchange Transactions (summary totals, not individual trades)",
    fields: {
      payer:             { type: ["string","null"], description: "Brokerage name" },
      shortTermProceeds: { type: ["number","null"], description: "Total short-term proceeds (Box 1d aggregate)" },
      shortTermBasis:    { type: ["number","null"], description: "Total short-term cost or other basis (Box 1e aggregate)" },
      shortTermGain:     { type: ["number","null"], description: "Net short-term gain or loss (proceeds minus basis; negative = loss)" },
      longTermProceeds:  { type: ["number","null"], description: "Total long-term proceeds" },
      longTermBasis:     { type: ["number","null"], description: "Total long-term cost or other basis" },
      longTermGain:      { type: ["number","null"], description: "Net long-term gain or loss (negative = loss)" },
    },
    required: ["payer"],
  },

  "5498-SA": {
    description: "IRS Form 5498-SA HSA, Archer MSA, or Medicare Advantage MSA Information",
    fields: {
      payer:                 { type: ["string","null"], description: "HSA trustee or custodian name" },
      hsaContributions:      { type: ["number","null"], description: "Box 2 — Total HSA contributions (employee + employer combined)" },
      employerContributions: { type: ["number","null"], description: "Box 9 — Employer contributions (may not appear; use 0 if not shown)" },
    },
    required: ["payer", "hsaContributions"],
  },

  "1099-SA": {
    description: "IRS Form 1099-SA Distributions from an HSA",
    fields: {
      payer:                  { type: ["string","null"], description: "HSA trustee or custodian name" },
      distributions:          { type: ["number","null"], description: "Box 1 — Gross distribution" },
      qualifiedDistributions: { type: ["number","null"], description: "Amount used for qualified medical expenses (not taxable); estimate if not printed" },
    },
    required: ["payer", "distributions"],
  },
};

/* ─── Helpers ───────────────────────────────────────────────── */
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

function guessMimeType(contentType, key) {
  if (contentType && contentType !== "application/octet-stream") return contentType;
  const lower = (key || "").toLowerCase();
  if (lower.endsWith(".pdf"))                        return "application/pdf";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png"))                        return "image/png";
  return "application/octet-stream";
}

async function extractWithClaude({ bytes, mimeType, docType, schema }) {
  const base64   = bytes.toString("base64");
  const isPdf    = mimeType === "application/pdf";

  const mediaBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image",    source: { type: "base64", media_type: mimeType,           data: base64 } };

  const inputSchema = {
    type: "object",
    properties: schema.fields,
    required: schema.required,
  };

  const response = await anthropic().messages.create({
    model:      MODEL,
    max_tokens: 1024,
    system: `You extract structured data from US tax documents for a personal finance application.
Return numeric values as numbers (not strings). Copy exact amounts from the form — do not round or estimate
unless the field is genuinely absent, in which case use null.`,
    messages: [{
      role:    "user",
      content: [
        mediaBlock,
        { type: "text", text: `This is a ${schema.description}. Extract all relevant fields and call the extract_tax_document tool with the structured data.` },
      ],
    }],
    tools: [{
      name:         "extract_tax_document",
      description:  `Extract structured data from a ${schema.description}`,
      input_schema: inputSchema,
    }],
    tool_choice: { type: "tool", name: "extract_tax_document" },
  });

  const toolUse = response.content.find(b => b.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not call extract_tax_document tool");
  return toolUse.input;
}

/* ─── Per-record processor ──────────────────────────────────── */
async function processRecord(rec) {
  const bucket = rec?.s3?.bucket?.name;
  const key    = decodeURIComponent(String(rec?.s3?.object?.key || "").replace(/\+/g, " "));

  if (!bucket || !key) throw new Error("Bad S3 event record: missing bucket or key");
  console.log("Processing s3://" + bucket + "/" + key);

  // Key format: {accountId}/{year}/{docId}/{filename}
  const parts = key.split("/");
  if (parts.length < 4) {
    console.log("Key format unexpected — skipping:", key);
    return { skipped: true, reason: "unexpected-key-format", key };
  }
  const [accountId, year, docId] = parts;

  // Fetch DDB record to get docType
  const existing = await getItem(accountId, `TAX_DOC#${year}#${docId}`);
  if (!existing) {
    console.log("No DDB record found — skipping:", key);
    return { skipped: true, reason: "no-ddb-record", key };
  }

  const docType = existing.docType;
  const schema  = SCHEMAS[docType];
  if (!schema) {
    console.log(`No extraction schema for docType="${docType}" — skipping`);
    return { skipped: true, reason: `unknown-docType:${docType}`, key };
  }

  // Download file
  const obj      = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes    = await streamToBuffer(obj.Body);
  const mimeType = guessMimeType(obj.ContentType, key);
  console.log(`Downloaded ${bytes.length}B mimeType=${mimeType} docType=${docType}`);

  if (mimeType !== "application/pdf" && !mimeType.startsWith("image/")) {
    console.log("Unsupported mimeType — skipping:", mimeType);
    return { skipped: true, reason: `unsupported-mime:${mimeType}`, key };
  }

  // Extract via Claude
  console.log(`Calling Claude model=${MODEL} for docType=${docType}…`);
  const extracted = await extractWithClaude({ bytes, mimeType, docType, schema });
  console.log("Extracted:", JSON.stringify(extracted));

  // Merge into existing data (preserves s3Key + any manual edits that differ from extraction)
  // Null-extracted fields do NOT overwrite existing non-null manual values
  const mergedData = { ...existing.data };
  for (const [k, v] of Object.entries(extracted)) {
    if (v !== null && v !== undefined) mergedData[k] = v;
    else if (mergedData[k] === undefined) mergedData[k] = null;
  }
  // Always preserve the s3Key reference
  if (existing.data?.s3Key) mergedData.s3Key = existing.data.s3Key;

  await putItem({
    ...existing,
    data:      mergedData,
    status:    "extracted",
    updatedAt: new Date().toISOString(),
  });

  console.log("DDB updated — status=extracted");
  return { ok: true, docType, docId, accountId, fieldsExtracted: Object.keys(extracted).length };
}

/* ─── Handler ───────────────────────────────────────────────── */
exports.handler = async (event) => {
  console.log("EVENT:", JSON.stringify(event));

  const records = Array.isArray(event?.Records) ? event.Records : [];
  if (!records.length) {
    console.log("No S3 records — nothing to process");
    return { ok: true, processed: 0 };
  }

  const results = [];
  for (const rec of records) {
    try {
      results.push(await processRecord(rec));
    } catch (err) {
      console.error("processRecord failed:", err);
      // Don't rethrow — log the failure and process remaining records.
      // The DLQ will capture this invocation's failure if all records fail.
      results.push({ ok: false, error: String(err?.message || err) });
    }
  }

  return { ok: true, results };
};
