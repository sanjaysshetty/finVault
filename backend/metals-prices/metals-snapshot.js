// metals-snapshot.mjs
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const BUCKET = process.env.METALS_BUCKET || "daily-metal-prices-1152";

const GOLDAPI_BASE = "https://www.goldapi.io/api";
const GOLDAPI_KEY = process.env.GOLDAPI_KEY;

if (!GOLDAPI_KEY) throw new Error("Missing GOLDAPI_KEY env var");

const s3 = new S3Client({ region: REGION });

function isoDateUTC(d = new Date()) {
  return d.toISOString().slice(0, 10);
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
  const currency = "USD";
  const dateISO = isoDateUTC();

  // Metals you requested
  const metals = ["XAU", "XAG"];

  const results = {};
  const errors = {};

  // Fetch sequentially to be gentle on GoldAPI (only 3 calls/day anyway)
  for (const metal of metals) {
    try {
      const data = await fetchGoldApiMetal(metal, currency);

      // Add a few helpful fields so the consumer can show "as-of"
      const payload = {
        ...data,
        metal,
        currency,
        asOfDate: dateISO,
        fetchedAt: new Date().toISOString(),
        source: "goldapi.io",
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
    results,
    errors: Object.keys(errors).length ? errors : undefined,
  };

  console.log("Snapshot summary:", JSON.stringify(summary));
  return summary;
};
