import fs from "fs";
import xlsx from "xlsx";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.TABLE_NAME || "CostcoSpending";
const REGION =
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const XLSX_PATH = process.env.XLSX_PATH || "./Costco_Spending.xlsx";

function pad6(n) {
  return String(n).padStart(6, "0");
}

// Case/whitespace-insensitive header lookup
function getField(row, name) {
  const target = String(name).trim().toLowerCase();
  for (const k of Object.keys(row || {})) {
    if (String(k).trim().toLowerCase() === target) return row[k];
  }
  return undefined;
}

// Excel serial (days since 1899-12-30) -> JS Date (UTC)
function excelSerialToJSDate(serial) {
  // Keep fractional day portion (time)
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms);
}

function isoDate(val) {
  if (val === null || val === undefined || val === "") return "";

  // 1) Date object
  if (val instanceof Date && Number.isFinite(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }

  // 2) Excel serial number
  if (typeof val === "number" && Number.isFinite(val)) {
    // Excel serials for modern dates are usually > 20000
    const d = val > 20000 ? excelSerialToJSDate(val) : new Date(val);
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "";
  }

  // 3) String: could be "3/19/2023", "2023-03-19", or "45123"
  if (typeof val === "string") {
    const s = val.trim();
    if (!s) return "";

    // If it looks like a number, treat as possible Excel serial
    if (/^\d+(\.\d+)?$/.test(s)) {
      const num = Number(s);
      if (Number.isFinite(num) && num > 20000) {
        const d = excelSerialToJSDate(num);
        return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "";
      }
      // If it’s a small number, don't interpret as excel date; fall through
    }

    // Normal parsing for date strings
    const d = new Date(s);
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "";
  }

  return "";
}

function toNumber(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

async function batchWriteAll(ddb, requests) {
  let i = 0;
  while (i < requests.length) {
    const chunk = requests.slice(i, i + 25);
    i += 25;

    let unprocessed = { [TABLE_NAME]: chunk };
    let attempts = 0;

    while (Object.keys(unprocessed).length && attempts < 8) {
      attempts += 1;

      const resp = await ddb.send(
        new BatchWriteCommand({
          RequestItems: unprocessed,
        })
      );

      const up = resp.UnprocessedItems?.[TABLE_NAME] || [];
      if (!up.length) {
        unprocessed = {};
        break;
      }

      const delay = Math.min(500 * 2 ** (attempts - 1), 8000);
      await new Promise((r) => setTimeout(r, delay));

      unprocessed = { [TABLE_NAME]: up };
    }

    if (Object.keys(unprocessed).length) {
      throw new Error(
        `Failed to write some items after retries. Remaining: ${unprocessed[TABLE_NAME].length}`
      );
    }

    if ((i / 25) % 20 === 0) {
      console.log(
        `Progress: wrote ~${Math.min(i, requests.length)} / ${requests.length} items`
      );
    }
  }
}

async function main() {
  if (!fs.existsSync(XLSX_PATH)) {
    throw new Error(`XLSX not found at: ${XLSX_PATH}`);
  }

  console.log(`Reading: ${XLSX_PATH}`);

  // cellDates:true helps parse date cells as Date objects when possible
  const wb = xlsx.readFile(XLSX_PATH, { cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];

  // raw:true preserves underlying types (numbers remain numbers)
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: "", raw: true });

  console.log(`Rows: ${rows.length}`);
  console.log("Headers detected:", Object.keys(rows[0] || {}));

  // Debug sample (safe): shows raw and parsed values
  const sample = rows.slice(0, 8).map((r) => {
    const rawDate = getField(r, "Date");
    return { rawDate, parsed: isoDate(rawDate) };
  });
  console.log("Sample Date parse:", sample);

  // Build PutRequests
  const putRequests = rows.map((r, idx) => {
    const receipt = String(getField(r, "Receipt") || "").trim();
    const productCode = getField(r, "Product code");
    const productDesc = String(getField(r, "Product Description") || "").trim();
    const dateStr = isoDate(getField(r, "Date"));
    const amount = toNumber(getField(r, "Amount"));
    const category = String(getField(r, "Category") || "").trim();

    const pk = `RECEIPT#${receipt || "UNKNOWN"}`;
    const sk = `LINE#${pad6(idx + 1)}`;

    const gsi1pk = dateStr ? `DATE#${dateStr}` : "DATE#UNKNOWN";
    const gsi1sk = `${pk}#${sk}`;

    return {
      PutRequest: {
        Item: {
          pk,
          sk,
          gsi1pk,
          gsi1sk,

          receipt,
          lineId: idx + 1,

          productCode: productCode === "" ? "" : String(productCode),
          productDescription: productDesc,
          date: dateStr,
          amount,
          category,

          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    };
  });

  const client = new DynamoDBClient({ region: REGION });
  const ddb = DynamoDBDocumentClient.from(client);

  console.log(
    `Writing to DynamoDB table: ${TABLE_NAME} (region: ${REGION}) ...`
  );
  await batchWriteAll(ddb, putRequests);

  console.log("✅ Migration complete.");
}

main().catch((e) => {
  console.error("❌ Migration failed:", e);
  process.exit(1);
});
