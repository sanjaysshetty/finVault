import OpenAI from "openai";
import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
  PutItemCommand
} from "@aws-sdk/client-dynamodb";
import { unmarshall, marshall } from "@aws-sdk/util-dynamodb";

const ddb = new DynamoDBClient({});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CATEGORY_MASTER_TABLE = process.env.CATEGORY_MASTER_TABLE;
const CATEGORY_PROPOSALS_TABLE = process.env.CATEGORY_PROPOSALS_TABLE;
const CURATED_TABLE = process.env.CURATED_TABLE;
const AGG_TABLE = process.env.AGG_TABLE;
const MODEL = process.env.OPENAI_MODEL || "gpt-5";

let cachedTaxonomy = null;
let cachedAt = 0;

function monthFromDate(dateStr) {
  return (dateStr && dateStr.length >= 7) ? dateStr.slice(0, 7) : "unknown";
}

async function getTaxonomy() {
  const now = Date.now();
  if (cachedTaxonomy && (now - cachedAt) < 5 * 60 * 1000) return cachedTaxonomy;

  const resp = await ddb.send(new GetItemCommand({
    TableName: CATEGORY_MASTER_TABLE,
    Key: marshall({ pk: "TAXONOMY", sk: "CURRENT" })
  }));
  if (!resp.Item) throw new Error("CategoryMaster missing TAXONOMY/CURRENT");

  cachedTaxonomy = unmarshall(resp.Item);
  cachedAt = now;
  return cachedTaxonomy;
}

async function llmClassify(raw, taxonomy) {
  // taxonomy.categories could be stored as string or list depending on your seed.
  // If you stored it as a string, parse it:
  const cats = typeof taxonomy.categories === "string"
    ? JSON.parse(taxonomy.categories)
    : (taxonomy.categories || []);

  const instructions = `
Classify a receipt line item into an existing taxonomy of Category/Subcategory.
You MUST select from the provided taxonomy.
If none fits, set proposeNew=true and provide a proposed category/subcategory.
Return ONLY JSON with keys: category, subcategory, confidence, proposeNew, proposed(optional: {category, subcategory, reason}).
`;

  const resp = await openai.responses.create({
    model: MODEL,
    reasoning: { effort: "low" },
    instructions,
    input: [
      { role: "user", content: `taxonomy=${JSON.stringify(cats)}` },
      { role: "user", content: `item=${JSON.stringify({
        store: raw.store || raw.receipt?.storeName || "unknown",
        productCode: raw.productCode || "",
        description: raw.productDescription || raw.description || "",
        rawCategory: raw.category || ""
      })}` }
    ],
    text: { format: { type: "json_object" } }
  });

  const out = JSON.parse(resp.output_text);
  return out;
}

async function writeProposal(userId, raw, cls) {
  if (!cls.proposeNew) return;

  const date = raw.date || "unknown";
  const pk = `USER#${userId}`;
  const sk = `DATE#${date}#${raw.pk}#${raw.sk}`;

  await ddb.send(new PutItemCommand({
    TableName: CATEGORY_PROPOSALS_TABLE,
    Item: marshall({
      pk, sk,
      createdAt: new Date().toISOString(),
      store: raw.store || raw.receipt?.storeName || "unknown",
      productCode: raw.productCode || null,
      description: raw.productDescription || raw.description || null,
      suggestedCategory: cls.proposed?.category || cls.category,
      suggestedSubcategory: cls.proposed?.subcategory || cls.subcategory,
      reason: cls.proposed?.reason || "No reason"
    })
  }));
}

export const handler = async (event) => {
  const taxonomy = await getTaxonomy();
  const taxonomyVersion = Number(taxonomy.version || 1);

  for (const r of event.Records || []) {
    if (!["INSERT", "MODIFY"].includes(r.eventName)) continue;
    const img = r.dynamodb?.NewImage;
    if (!img) continue;

    const raw = unmarshall(img);
    if (!raw.pk || !raw.sk || !raw.userId || !raw.date) continue;

    const cls = await llmClassify(raw, taxonomy);
    await writeProposal(raw.userId, raw, cls);

    const curated = {
      pk: raw.pk,
      sk: raw.sk,
      userId: raw.userId,
      date: raw.date,
      amount: raw.amount !== undefined ? Number(raw.amount) : 0,
      store: raw.store || raw.receipt?.storeName || null,
      productCode: raw.productCode || null,
      productDescription: raw.productDescription || raw.description || null,
      categoryRaw: raw.category || null,
      categoryNormalized: cls.category,
      subcategoryNormalized: cls.subcategory,
      confidence: Number(cls.confidence ?? 0.7),
      taxonomyVersion,
      curatedAt: new Date().toISOString()
    };

    const month = monthFromDate(curated.date);
    const aggKey = {
      pk: `USER#${curated.userId}#MONTH#${month}`,
      sk: `CAT#${curated.categoryNormalized}#SUB#${curated.subcategoryNormalized}`
    };

    try {
      await ddb.send(new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: CURATED_TABLE,
              Item: marshall(curated),
              ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)"
            }
          },
          {
            Update: {
              TableName: AGG_TABLE,
              Key: marshall(aggKey),
              UpdateExpression: "ADD totalAmount :a, transactionCount :one SET lastUpdatedAt=:t",
              ExpressionAttributeValues: marshall({
                ":a": curated.amount,
                ":one": 1,
                ":t": new Date().toISOString()
              })
            }
          }
        ]
      }));
    } catch (e) {
      // If already curated, skip (prevents double-count)
      if (String(e.name || "").includes("ConditionalCheckFailed")) continue;
      throw e;
    }
  }

  return { ok: true };
};
