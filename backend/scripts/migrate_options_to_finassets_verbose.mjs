#!/usr/bin/env node
/**
 * Verbose one-time migration: Options.xlsx -> DynamoDB finAssets (OPTIONS_TX)
 *
 * Designed for debugging "nothing migrated" situations.
 *
 * Install:
 *   npm i xlsx @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
 *
 * Run (dry-run):
 *   node migrate_options_to_finassets_verbose.mjs --xlsx ./Options.xlsx --table finAssets --region us-east-1 --dry-run --verbose
 *
 * Run (write):
 *   node migrate_options_to_finassets_verbose.mjs --xlsx ./Options.xlsx --table finAssets --region us-east-1
 *
 * Optional:
 *   --sheet "SheetName"
 */
import fs from "node:fs";
import crypto from "node:crypto";
import process from "node:process";

import XLSX from "xlsx";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const USER_ID = "a4989438-e001-7005-babe-0e92e91c028a";
const ASSET_TYPE = "OPTIONS_TX";

function arg(name, defVal = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return defVal;
  return process.argv[idx + 1] ?? defVal;
}

const XLSX_PATH = arg("--xlsx", "./Options.xlsx");
const TABLE_NAME = arg("--table", "finAssets");
const REGION = arg("--region", process.env.AWS_REGION || "us-east-1");
const DRY_RUN = process.argv.includes("--dry-run");
const SHEET = arg("--sheet", "");
const VERBOSE = process.argv.includes("--verbose");

function log(...a) { console.log(...a); }
function vlog(...a) { if (VERBOSE) console.log(...a); }

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === "";
}
function upperTrim(v) {
  return String(v ?? "").toUpperCase().trim();
}
function nowIso() {
  return new Date().toISOString();
}
function normalizeType(v) {
  const t = upperTrim(v);
  const allowed = new Set(["SELL", "BUY", "ASS", "ASSIGNED", "SDI"]);
  if (!allowed.has(t)) throw new Error(`Invalid type: ${v}`);
  return t;
}
function toISODateOrBlank(v) {
  if (isBlank(v)) return "";
  let d;
  if (v instanceof Date) d = v;
  else if (typeof v === "number") {
    const dc = XLSX.SSF.parse_date_code(v);
    if (!dc) return "";
    d = new Date(Date.UTC(dc.y, dc.m - 1, dc.d));
  } else {
    const s = String(v).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
    return s;
  }
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function toNumOrBlank(v) {
  if (isBlank(v)) return "";
  const n = Number(v);
  return Number.isFinite(n) ? n : "";
}

// Safe eval for simple arithmetic like "=6.5+2.05-0.1"
function evalArithmetic(expr) {
  if (isBlank(expr)) return null;
  const cleaned = String(expr).replace(/^=/, "").trim();
  if (!/^[0-9+\-*/().\s]+$/.test(cleaned)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (${cleaned});`);
    const v = fn();
    return Number.isFinite(v) ? Number(v) : null;
  } catch {
    return null;
  }
}

function makeAssetId(openDate, ticker, type, rowNum) {
  const base = `otx-migrate-${openDate}-${ticker}-${type}-r${rowNum}`;
  const hash = crypto.createHash("sha1").update(base).digest("hex").slice(0, 12);
  return `otx-${hash}`;
}

function pickSheetName(wb) {
  if (SHEET) {
    if (!wb.SheetNames.includes(SHEET)) {
      throw new Error(`--sheet "${SHEET}" not found. Available: ${wb.SheetNames.join(", ")}`);
    }
    return SHEET;
  }
  return wb.SheetNames[0];
}

// Normalize header names (trim, collapse spaces)
function normHeader(h) {
  return String(h ?? "").replace(/\s+/g, " ").trim();
}

function findHeaderRow(ws, maxRowsToCheck = 15) {
  const ref = ws["!ref"];
  if (!ref) throw new Error("Worksheet has no !ref");
  const range = XLSX.utils.decode_range(ref);

  const required = ["Type", "Open", "Expiry", "Close", "Ticker", "Qty", "Fill $", "P/L"];
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + maxRowsToCheck); r++) {
    const headers = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      headers.push(normHeader(ws[addr]?.v ?? ""));
    }
    const hasAll = required.every(req => headers.includes(req));
    if (hasAll) return { headerRowIdx: r, headers };
  }
  throw new Error(`Could not find a header row containing: ${required.join(", ")}`);
}

function colIndex(headers, name) {
  const idx = headers.indexOf(name);
  if (idx < 0) throw new Error(`Could not find column "${name}" in header`);
  return idx;
}

function readRows(wb, ws) {
  const { headerRowIdx, headers } = findHeaderRow(ws);

  vlog("Detected header row:", headerRowIdx + 1);
  vlog("Headers:", headers);

  const rows = XLSX.utils.sheet_to_json(ws, {
    defval: "",
    range: headerRowIdx,
  });

  const fillCol = colIndex(headers, "Fill $");
  const plCol = colIndex(headers, "P/L");

  const startDataRow = headerRowIdx + 1;

  const ref = ws["!ref"];
  const range = XLSX.utils.decode_range(ref);

  return rows.map((r, i) => {
    const excelRowIdx = startDataRow + i;
    const fillAddr = XLSX.utils.encode_cell({ r: excelRowIdx, c: fillCol });
    const plAddr = XLSX.utils.encode_cell({ r: excelRowIdx, c: plCol });

    const fillCell = ws[fillAddr];
    const plCell = ws[plAddr];

    let fillValue = r["Fill $"];
    let fillFormula = "";
    if (fillCell?.f) {
      fillFormula = String(fillCell.f);
      if (isBlank(fillValue)) {
        const maybe = evalArithmetic(fillFormula);
        if (maybe !== null) fillValue = maybe;
      }
    }

    return {
      ...r,
      "__rowNum": excelRowIdx + 1,
      "__fillValue": fillValue,
      "__fillFormula": fillFormula,
      "__plBlank": isBlank(plCell?.v ?? r["P/L"]),
    };
  }).filter(x => (x.__rowNum - 1) <= range.e.r);
}

function buildItem(r) {
  const rowNum = Number(r["__rowNum"] ?? 0) || 0;

  const type = normalizeType(r["Type"]);
  const openDate = toISODateOrBlank(r["Open"]);
  const expiry = toISODateOrBlank(r["Expiry"]);
  const closeDateExcel = toISODateOrBlank(r["Close"]);
  const ticker = upperTrim(r["Ticker"]);

  if (!openDate) throw new Error(`Row ${rowNum}: Open date missing/invalid`);
  if (!ticker) throw new Error(`Row ${rowNum}: Ticker missing`);

  const qty = Number(r["Qty"]);
  if (!Number.isFinite(qty) || qty === 0) throw new Error(`Row ${rowNum}: Qty invalid`);

  const fill = Number(r["__fillValue"]);
  if (!Number.isFinite(fill) || fill === 0) throw new Error(`Row ${rowNum}: Fill invalid`);

  const closePriceRaw = r["Close $"];
  const closePriceNum = toNumOrBlank(closePriceRaw);

  const fee = toNumOrBlank(r["Fee"]);
  const coll = toNumOrBlank(r["Coll"]);

  const plBlank = Boolean(r["__plBlank"]);
  const isOpen = plBlank || isBlank(closePriceRaw);

  const closeDate = isOpen ? "" : closeDateExcel;
  const closePrice = isOpen ? "" : (closePriceNum === "" ? "" : Number(closePriceNum));

  const rollOver = !isBlank(r["__fillFormula"])
    ? String(r["__fillFormula"]).replace(/^=/, "")
    : String(r["__fillValue"]);

  const assetId = makeAssetId(openDate, ticker, type, rowNum);
  const now = nowIso();

  return {
    userId: USER_ID,
    assetId,
    txId: assetId,
    assetType: ASSET_TYPE,

    type,
    openDate,
    expiry,
    closeDate,

    ticker,
    event: String(r["Event"] ?? "").trim(),
    strikes: String(r["K(s)"] ?? "").trim(),

    qty: Number(qty),
    fill: Number(fill),
    closePrice,

    fee: fee === "" ? "" : Number(fee),
    coll: coll === "" ? "" : Number(coll),

    rollOver,
    notes: String(r["Notes"] ?? "").trim(),

    gsi1pk: USER_ID,
    gsi1sk: `${ASSET_TYPE}#${openDate}#${assetId}`,

    createdAt: now,
    updatedAt: now,
  };
}

async function main() {
  log("=== finAssets OPTIONS_TX migration (verbose) ===");
  log("XLSX:", XLSX_PATH);
  log("Table:", TABLE_NAME, "Region:", REGION, "DryRun:", DRY_RUN);
  log("UserId:", USER_ID);

  if (!fs.existsSync(XLSX_PATH)) throw new Error(`XLSX file not found at: ${XLSX_PATH}`);

  const wb = XLSX.readFile(XLSX_PATH, { cellDates: true, cellFormula: true });
  log("Workbook sheets:", wb.SheetNames.join(", "));

  const sheetName = pickSheetName(wb);
  log("Using sheet:", sheetName);

  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error("Worksheet missing");

  const rows = readRows(wb, ws);
  log("Rows read (including possible blanks):", rows.length);

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  let processed = 0;
  let skipped = 0;
  let written = 0;

  const firstErrors = [];
  const preview = [];

  for (const r of rows) {
    const rowNum = Number(r["__rowNum"] ?? 0) || 0;

    if (isBlank(r["Type"]) && isBlank(r["Ticker"])) {
      skipped++;
      continue;
    }

    try {
      const item = buildItem(r);
      processed++;
      if (preview.length < 5) preview.push(item);

      if (!DRY_RUN) {
        await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
        written++;
      }
    } catch (e) {
      skipped++;
      if (firstErrors.length < 10) firstErrors.push({ row: rowNum, err: e?.message || String(e) });
      vlog(`Skip row ${rowNum}:`, e?.message || e);
    }
  }

  log("Processed items:", processed);
  log("Written items:", DRY_RUN ? 0 : written);
  log("Skipped rows:", skipped);
  log("Preview (up to 5):");
  log(JSON.stringify(preview, null, 2));

  if (firstErrors.length) {
    log("First errors (up to 10):");
    log(JSON.stringify(firstErrors, null, 2));
  }

  if (processed === 0) {
    log("");
    log("Nothing processed. Common causes:");
    log("- Header names don’t match expected (Type, Open, Expiry, Close, Ticker, Qty, Fill $, P/L)");
    log("- Data is on a different sheet (use --sheet "<name>")");
    log("- Rows have blank Type/Ticker so they are skipped");
  }
}

main().catch((e) => {
  console.error("Migration failed:", e?.message || e);
  process.exit(1);
});