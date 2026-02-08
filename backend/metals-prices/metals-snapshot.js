// metals-snapshot.mjs
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const BUCKET = process.env.METALS_BUCKET || "daily-metal-prices-1152";

const GOLDAPI_BASE = "https://www.goldapi.io/api";
const GOLDAPI_KEY = process.env.GOLDAPI_KEY;

if (!GOLDAPI_KEY) throw new Error("Missing GOLDAPI_KEY env var");

const s3 = new S3Client({ region: REGION });

/**
 * Returns weekday name ("Sunday", "Monday", ...) for a Date in America/Chicago.
 */
function weekdayCentral(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "long",
  }).formatToParts(d);
  return parts.find((p) => p.type === "weekday")?.value || "";
}

/**
 * Returns YYYY-MM-DD for a Date in America/Chicago.
 * (So your S3 key aligns to “5 AM Central run day”, not UTC.)
 */
function isoDateCentral(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${day}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchGoldApiMetal(metal, currency = "USD") {
  const url = `${GOLDAPI_BASE}/${metal}/${currency}`;
  const resp = await fetchWithTimeout(
    url,
    {
      headers: {
        "x-access-token": GOLDAPI_KEY,
        "Content-Type": "application/json",
      },
    },
    6000
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GoldAPI ${metal} ${resp.status}: ${text}`);
  }

  return resp.json();
}

function s3KeyFor(metal, dateISO) {
  // Example: metals/XAU/2026-02-02.json
  return `metals/${metal}/${dateISO}.json`;
}

async function putJson(bucket, key, obj) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(obj),
      ContentType: "application/json",
      CacheControl: "no-store",
    })
  );
}

export const handler = async () => {
  // Determine “today” based on Central time (your schedule is 5 AM Central)
  const now = new Date();
  const centralWeekday = weekdayCentral(now);
  const dateISO = isoDateCentral(now);

  // ✅ Skip Sundays (based on Central time)
  if (centralWeekday === "Sunday") {
    const summary = {
      bucket: BUCKET,
      dateISO,
      skipped: true,
      reason: "Sunday in America/Chicago (skip GoldAPI call).",
      results: {},
      errors: undefined,
    };

    console.log("Snapshot summary (skipped):", JSON.stringify(summary));
    return summary;
  }

  const currency = "USD";
  const metals = ["XAU", "XAG"];

  const results = {};
  const errors = {};

  // Fetch sequentially to be gentle on GoldAPI
  for (const metal of metals) {
    try {
      const data = await fetchGoldApiMetal(metal, currency);

      const payload = {
        ...data,
        metal,
        currency,
        asOfDate: dateISO, // Central-date aligned
        fetchedAt: new Date().toISOString(),
        source: "goldapi.io",
        timezoneBasis: "America/Chicago",
      };

      const key = s3KeyFor(metal, dateISO);
      await putJson(BUCKET, key, payload);

      results[metal] = { ok: true, key };
      console.log(`Wrote ${metal} to s3://${BUCKET}/${key}`);
    } catch (e) {
      errors[metal] = String(e?.message || e);
      console.error(`Failed ${metal}:`, errors[metal]);
    }
  }

  const summary = {
    bucket: BUCKET,
    dateISO,
    skipped: false,
    results,
    errors: Object.keys(errors).length ? errors : undefined,
  };

  console.log("Snapshot summary:", JSON.stringify(summary));
  return summary;
};
