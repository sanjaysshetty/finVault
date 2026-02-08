#!/usr/bin/env node
/**
 * One-time migration: Options.xlsx -> DynamoDB finAssets (OPTIONS_TX)
 *
 * Rules implemented:
 *  - If Excel P/L is blank => treat as OPEN (force closeDate="", closePrice="")
 *  - If "Fill $" cell is a formula (e.g. =6.5+2.05-0.1), store the expression (without leading '=') in rollOver
 *    If Fill $ is a single value, store that value (string) in rollOver
 *  - Do NOT import P/L or Annual ROC (your app keeps current calculations)
 *
 * Usage:
 *   npm i xlsx @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
 *   node migrate_options_to_finassets.mjs --xlsx ./Options.xlsx --table finAssets --region us-east-1 --dry-run
 *   node migrate_options_to_finassets.mjs --xlsx ./Options.xlsx --table finAssets --region us-east-1
 */

import fs from "node:fs";
import path from "node:path";
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
const LIMIT = Number(arg("--limit", "0")); // 0 = no limit

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === "";
}

function upperTrim(v) {
  return String(v ?? "").toUpperCase().trim();
}

function toISODateOrBlank(v) {
  if (isBlank(v)) return "";
  // v might be: JS Date, string "YYYY-MM-DD", or Excel serial number
  let d;
  if (v instanceof Date) d = v;
  else if (typeof v === "number") {
    // Excel serial -> Date
    const dc = XLSX.SSF.parse_date_code(v);
    if (!dc) return "";
    d = new Date(Date.UTC(dc.y, dc.m - 1, dc.d));
  } else {
    const s = String(v).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      throw new Error(`Invalid date (expected YYYY-MM-DD): ${v}`);
    }
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
  if (!Number.isFinite(n)) return "";
  return n;
}

// Safe eval for simple arithmetic formulas like "6.5+2.05-0.1"
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

function makeTxId(openDate, ticker, type, rowNum) {
  // deterministic-ish per sheet row to avoid duplicates across reruns
  const base = `otx-migrate-${openDate || "NA"}-${ticker || "NA"}-${type || "NA"}-r${rowNum}`;
  const hash = crypto.createHash("sha1").update(base).digest("hex").slice(0, 10);
  return `otx-${hash}`;
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

function buildItemFromRow(row, rowNum) {
  // Columns from your spreadsheet:
  // Type, Open, Expiry, Close, Ticker, Event, K(s), Qty, Fill $, Close $, Fee, Coll, P/L, ... Notes
  const type = normalizeType(row["Type"]);
  const openDate = toISODateOrBlank(row["Open"]);
  if (!openDate) throw new Error(`Row ${rowNum}: openDate is required`);
  const expiry = toISODateOrBlank(row["Expiry"]);
  const closeDateExcel = toISODateOrBlank(row["Close"]);

  const ticker = upperTrim(row["Ticker"]);
  if (!ticker) throw new Error(`Row ${rowNum}: ticker is required`);

  const event = String(row["Event"] ?? "").trim();
  const strikes = String(row["K(s)"] ?? "").trim();
  const qty = Number(row["Qty"]);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Row ${rowNum}: qty must be > 0`);

  // Fill may be numeric or formula; our parser provides two fields: __fillValue and __fillFormula
  const fill = Number(row["__fillValue"]);
  if (!Number.isFinite(fill) || fill <= 0) throw new Error(`Row ${rowNum}: fill must be > 0`);

  const closePriceRaw = row["Close $"];
  const closePriceNum = toNumOrBlank(closePriceRaw);

  const fee = toNumOrBlank(row["Fee"]);
  const coll = toNumOrBlank(row["Coll"]);
  const notes = String(row["Notes"] ?? "").trim();

  // OPEN vs CLOSED: P/L blank indicates OPEN
  const plBlank = isBlank(row["P/L"]);
  const isOpen = plBlank || isBlank(closePriceRaw);

  const closeDate = isOpen ? "" : closeDateExcel;
  const closePrice = isOpen ? "" : (closePriceNum === "" ? "" : Number(closePriceNum));

  // Roll Over rule:
  // if formula exists => store formula expression without leading '='
  // else store single value as string
  let rollOver = "";
  if (!isBlank(row["__fillFormula"])) {
    rollOver = String(row["__fillFormula"]).replace(/^=/, "");
  } else {
    rollOver = String(row["__fillValue"]);
  }

  const txId = makeTxId(openDate, ticker, type, rowNum);
  const now = nowIso();

  return {
    userId: USER_ID,
    assetId: txId,
    txId,
    assetType: ASSET_TYPE,
    type,
    openDate,
    expiry,
    closeDate,
    ticker,
    event,
    strikes,
    qty: Number(qty),
    fill: Number(fill),
    closePrice,
    fee: fee === "" ? "" : Number(fee),
    coll: coll === "" ? "" : Number(coll),
    rollOver,       // <-- added field (not used in math calcs)
    notes,

    gsi1pk: USER_ID,
    gsi1sk: `${ASSET_TYPE}#${openDate}#${txId}`,
    createdAt: now,
    updatedAt: now,
  };
}

function readWorkbookRows(xlsxPath) {
  if (!fs.existsSync(xlsxPath)) throw new Error(`XLSX not found: ${xlsxPath}`);
  const wb = XLSX.readFile(xlsxPath, {
    cellDates: true,
    cellFormula: true,
    cellNF: false,
    cellText: false,
  });

  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error("No worksheet found in xlsx");

  // Use json conversion for values; we'll separately access raw cell objects for formulas.
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  // We need to attach __fillValue and __fillFormula for each row
  // Find column indices by scanning header row (row 1)
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const headerRow = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: range.s.r, c });
    const cell = ws[addr];
    headerRow.push(cell?.v ?? "");
  }
  const colIndex = (name) => headerRow.findIndex((h) => String(h).trim() === name);

  const fillCol = colIndex("Fill $");
  const plCol = colIndex("P/L");

  if (fillCol < 0) throw new Error(`Could not find "Fill $" column in header`);
  if (plCol < 0) throw new Error(`Could not find "P/L" column in header`);

  // Row numbers in sheet_to_json start from 2 (because header is row 1)
  const enriched = rows.map((r, i) => {
    const excelRowNum = range.s.r + 2 + i; // 1-based row num
    const fillAddr = XLSX.utils.encode_cell({ r: excelRowNum - 1, c: fillCol });
    const fillCell = ws[fillAddr];

    let fillValue = r["Fill $"];
    let fillFormula = "";

    if (fillCell?.f) {
      fillFormula = String(fillCell.f);
      // If xlsx didn't provide computed value, try to evaluate simple arithmetic
      if (isBlank(fillValue)) {
        const maybe = evalArithmetic(fillFormula);
        if (maybe !== null) fillValue = maybe;
      }
    }

    return {
      ...r,
      "__rowNum": excelRowNum,
      "__fillValue": fillValue,
      "__fillFormula": fillFormula,
    };
  });

  return enriched;
}

async function main() {
  const rows = readWorkbookRows(XLSX_PATH);

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  let count = 0;
  const preview = [];

  for (const r of rows) {
    // skip completely empty lines (no Type and no Ticker)
    if (isBlank(r["Type"]) && isBlank(r["Ticker"])) continue;

    const rowNum = Number(r["__rowNum"] ?? 0) || 0;

    // Build item
    const item = buildItemFromRow(r, rowNum);
    count++;

    if (preview.length < 5) preview.push(item);

    if (LIMIT > 0 && count > LIMIT) break;

    if (!DRY_RUN) {
      await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
    }
  }

  console.log(`UserId: ${USER_ID}`);
  console.log(`Table: ${TABLE_NAME}  Region: ${REGION}`);
  console.log(`Rows processed: ${count}  (dryRun=${DRY_RUN})`);
  console.log("Preview (first up to 5 items):");
  console.log(JSON.stringify(preview, null, 2));
}

main().catch((e) => {
  console.error("Migration failed:", e?.message || e);
  process.exit(1);
});
