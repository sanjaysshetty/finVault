"use strict";

const crypto = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const { json, badRequest, notFound } = require("finvault-shared/http");
const { putItem, getItem, queryByGSI1 } = require("finvault-shared/ddb");
const { resolveContext, assertRead, assertWrite } = require("finvault-shared/resolveContext");
const { BUDGET_CATEGORIES, toBudgetCategory, isExcluded } = require("./categoryMap");

// Direct DDB client for StoreReceiptLedger (shared layer ddb.js is pinned to FIN_ASSETS_TABLE)
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const SPENDING_TABLE    = process.env.SPENDING_TABLE    || "StoreReceiptLedger";
const DATE_INDEX_NAME   = process.env.DATE_INDEX_NAME   || "UserDateIndex";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function resolveCtxCached(event) {
  if (!event._ctx) event._ctx = await resolveContext(event);
  return event._ctx;
}

async function getUserId(event) {
  const { accountId } = await resolveCtxCached(event);
  return accountId;
}

function getMethod(event) {
  return event?.requestContext?.http?.method || event?.httpMethod || "GET";
}

function getPath(event) {
  return event?.rawPath || event?.requestContext?.http?.path || event?.path || "/";
}

function parseBody(event) {
  if (!event?.body) return {};
  try { return JSON.parse(event.body); } catch { return {}; }
}

function newId() {
  return crypto.randomBytes(10).toString("hex");
}

function now() {
  return new Date().toISOString();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Validate YYYY-MM format
function parseYearMonth(year, month) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new Error("Invalid year");
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error("Invalid month (1-12)");
  return { y, m };
}

// ── Budget Definition helpers ─────────────────────────────────────────────────

function defaultCCBudgets() {
  return Object.fromEntries(BUDGET_CATEGORIES.map(c => [c.key, 0]));
}

function defaultBudgetDef() {
  return { fixedExpenses: [], loans: [], investments: [], creditCardBudgets: defaultCCBudgets() };
}

// Transparently migrate old records to the new 4-section shape.
function enrichBudgetDef(item) {
  if (!item) return null;
  const out = { ...item };
  // Migrate monthlyAmount → amount for line items from old saves
  for (const section of ["fixedExpenses", "loans", "investments"]) {
    out[section] = (out[section] || []).map(r =>
      r.amount == null && r.monthlyAmount != null ? { ...r, amount: r.monthlyAmount } : r
    );
  }
  if (!out.creditCardBudgets) {
    out.creditCardBudgets = item.categories
      ? Object.fromEntries(BUDGET_CATEGORIES.map(c => [c.key, item.categories[c.key]?.budget || 0]))
      : defaultCCBudgets();
  }
  return out;
}

// opts: { withDueDay, withFrequency }
// withFrequency adds frequency ("monthly"|"annual") + dueMonth (1-12) for annual fixed expenses
function validateLineItems(arr, label, opts = {}) {
  const { withDueDay = false, withFrequency = false } = opts;
  if (!Array.isArray(arr)) throw new Error(`${label} must be an array`);
  return arr.map((item, i) => {
    const name = String(item.name || "").trim();
    if (!name) throw new Error(`${label}[${i}].name is required`);
    const amount = Number(item.amount ?? item.monthlyAmount);
    if (!Number.isFinite(amount) || amount < 0)
      throw new Error(`${label}[${i}].amount must be >= 0`);
    const out = {
      id: item.id || newId(),
      name,
      amount: Math.round(amount * 100) / 100,
    };
    if (withDueDay) {
      const d = parseInt(item.dueDay, 10);
      out.dueDay = (d >= 1 && d <= 31) ? d : null;
    }
    if (withFrequency) {
      out.frequency = item.frequency === "annual" ? "annual" : "monthly";
      if (out.frequency === "annual") {
        const dm = parseInt(item.dueMonth, 10);
        out.dueMonth = (dm >= 1 && dm <= 12) ? dm : 1;
      }
    }
    return out;
  });
}

// ── Budget Definition ─────────────────────────────────────────────────────────
// Annual default: assetId = "BUDGET_DEF#2026"
// Monthly override: assetId = "BUDGET_DEF#2026-05"

async function getBudgetDefinition(event, year, month) {
  const userId = await getUserId(event);
  assertRead(await resolveCtxCached(event), "budget");

  if (month !== undefined) {
    const { y, m } = parseYearMonth(year, month);
    const assetId = `BUDGET_DEF#${y}-${pad2(m)}`;
    const item = await getItem(userId, assetId);
    return json(200, enrichBudgetDef(item) ?? { exists: false, ...defaultBudgetDef() });
  }

  const assetId = `BUDGET_DEF#${parseInt(year, 10)}`;
  const item = await getItem(userId, assetId);
  return json(200, enrichBudgetDef(item) ?? { exists: false, ...defaultBudgetDef() });
}

async function putBudgetDefinition(event, year, month) {
  const userId = await getUserId(event);
  assertWrite(await resolveCtxCached(event), "budget");
  const body = parseBody(event);

  let cleanData;

  if (body.fixedExpenses !== undefined || body.creditCardBudgets !== undefined) {
    // New 4-section format
    const fixedExpenses = validateLineItems(body.fixedExpenses || [], "fixedExpenses", { withDueDay: true, withFrequency: true });
    const loans         = validateLineItems(body.loans        || [], "loans",         { withDueDay: true });
    const investments   = validateLineItems(body.investments  || [], "investments",   { withDueDay: true });

    const creditCardBudgets = {};
    const ccIn = body.creditCardBudgets || {};
    for (const { key } of BUDGET_CATEGORIES) {
      const v = Number(ccIn[key] ?? 0);
      if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid CC budget for ${key}`);
      creditCardBudgets[key] = Math.round(v * 100) / 100;
    }

    // Also write the legacy categories field so old GET consumers still work
    const categories = Object.fromEntries(
      BUDGET_CATEGORIES.map(({ key, countsAsSavingsDefault }) => [
        key,
        { budget: creditCardBudgets[key], countsAsSavings: countsAsSavingsDefault },
      ])
    );

    cleanData = { fixedExpenses, loans, investments, creditCardBudgets, categories };
  } else if (body.categories && typeof body.categories === "object") {
    // Legacy format — keep working
    const categories = {};
    for (const [key, val] of Object.entries(body.categories)) {
      const budget = Number(val.budget);
      if (!Number.isFinite(budget) || budget < 0) throw new Error(`Invalid budget for ${key}`);
      categories[key] = { budget: Math.round(budget * 100) / 100, countsAsSavings: !!val.countsAsSavings };
    }
    const creditCardBudgets = Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, v.budget]));
    cleanData = { categories, creditCardBudgets, fixedExpenses: [], loans: [], investments: [] };
  } else {
    return badRequest("Provide fixedExpenses/creditCardBudgets (new format) or categories (legacy)");
  }

  const ts = now();

  if (month !== undefined) {
    const { y, m } = parseYearMonth(year, month);
    const assetId = `BUDGET_DEF#${y}-${pad2(m)}`;
    const item = {
      userId, assetId, gsi1pk: userId, gsi1sk: assetId,
      type: "BUDGET_DEF", year: y, month: m, isDefault: false,
      ...cleanData, updatedAt: ts,
      createdAt: (await getItem(userId, assetId))?.createdAt || ts,
    };
    await putItem(item);
    return json(200, item);
  }

  const y = parseInt(year, 10);
  const assetId = `BUDGET_DEF#${y}`;
  const item = {
    userId, assetId, gsi1pk: userId, gsi1sk: assetId,
    type: "BUDGET_DEF", year: y, isDefault: true,
    ...cleanData, updatedAt: ts,
    createdAt: (await getItem(userId, assetId))?.createdAt || ts,
  };
  await putItem(item);
  return json(200, item);
}

// ── CC Actuals ────────────────────────────────────────────────────────────────
// Aggregates spending for a month from StoreReceiptLedger, bucketed by budget category.

async function getCCActuals(event, year, month) {
  const userId = await getUserId(event);
  assertRead(await resolveCtxCached(event), "budget");
  const { y, m } = parseYearMonth(year, month);

  const items  = await fetchAllSpending(userId, `${y}-${pad2(m)}-`);
  const actuals = {};
  for (const item of items) {
    if (item.source === "budget-recurring" || item.source === "budget-override") continue;
    const cat = toBudgetCategory(item.category);
    if (isExcluded(cat)) continue;
    actuals[cat] = (actuals[cat] || 0) + Number(item.amount || 0);
  }

  for (const k of Object.keys(actuals)) actuals[k] = Math.round(actuals[k] * 100) / 100;
  return json(200, { actuals, year: y, month: m });
}

async function deleteBudgetOverride(event, year, month) {
  const userId = await getUserId(event);
  assertWrite(await resolveCtxCached(event), "budget");
  const { y, m } = parseYearMonth(year, month);
  const assetId = `BUDGET_DEF#${y}-${pad2(m)}`;
  const { deleteItem } = require("finvault-shared/ddb");
  await deleteItem(userId, assetId);
  return json(200, { deleted: true });
}

// ── Resolve effective CC budget for a month (annual + optional monthly override) ──
async function resolveEffectiveBudget(userId, year, month) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const [annual, monthly] = await Promise.all([
    getItem(userId, `BUDGET_DEF#${y}`),
    getItem(userId, `BUDGET_DEF#${y}-${pad2(m)}`),
  ]);
  const base = enrichBudgetDef(annual)?.creditCardBudgets || defaultCCBudgets();
  if (!monthly?.creditCardBudgets) return base;
  return { ...base, ...monthly.creditCardBudgets };
}

// ── Income ───────────────────────────────────────────────────────────────────
// assetId = "INCOME_DEF#2026"

async function getIncome(event, year) {
  const userId = await getUserId(event);
  assertRead(await resolveCtxCached(event), "budget");
  const y = parseInt(year, 10);
  const item = await getItem(userId, `INCOME_DEF#${y}`);
  return json(200, item || { exists: false, sources: [] });
}

async function putIncome(event, year) {
  const userId = await getUserId(event);
  assertWrite(await resolveCtxCached(event), "budget");
  const body = parseBody(event);
  const y = parseInt(year, 10);

  if (!Array.isArray(body.sources)) return badRequest("sources array is required");

  const sources = body.sources.map((s) => {
    const amount = Number(s.monthlyAmount);
    if (!s.name?.trim()) throw new Error("source name is required");
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid amount for ${s.name}`);
    return {
      id: s.id || newId(),
      name: String(s.name).trim(),
      monthlyAmount: Math.round(amount * 100) / 100,
      isActive: s.isActive !== false,
    };
  });

  const ts = now();
  const assetId = `INCOME_DEF#${y}`;
  const item = {
    userId, assetId,
    gsi1pk: userId,
    gsi1sk: assetId,
    type: "INCOME_DEF",
    year: y,
    sources,
    updatedAt: ts,
    createdAt: (await getItem(userId, assetId))?.createdAt || ts,
  };
  await putItem(item);
  return json(200, item);
}

// ── Goals ────────────────────────────────────────────────────────────────────
// assetId = "GOAL#2026#<uuid>"

const GOAL_TYPES = new Set([
  "SAVINGS", "INVESTMENT", "DEBT_PAYDOWN", "SPEND_CAP", "NET_WORTH", "CUSTOM",
]);

async function listGoals(event, year) {
  const userId = await getUserId(event);
  assertRead(await resolveCtxCached(event), "budget");
  const y = parseInt(year, 10);
  const items = await queryByGSI1(userId, `GOAL#${y}#`);
  return json(200, { goals: items });
}

async function createGoal(event, year) {
  const userId = await getUserId(event);
  assertWrite(await resolveCtxCached(event), "budget");
  const body = parseBody(event);
  const y = parseInt(year, 10);

  if (!body.name?.trim())              return badRequest("name is required");
  if (!GOAL_TYPES.has(body.goalType))  return badRequest("invalid goalType");
  const target = Number(body.targetAmount);
  if (!Number.isFinite(target) || target <= 0) return badRequest("targetAmount must be > 0");

  const goalId = newId();
  const assetId = `GOAL#${y}#${goalId}`;
  const ts = now();
  const item = {
    userId, assetId,
    gsi1pk: userId,
    gsi1sk: assetId,
    type: "FINANCIAL_GOAL",
    year: y,
    goalId,
    name: String(body.name).trim(),
    goalType: body.goalType,
    targetAmount: Math.round(target * 100) / 100,
    startingValue: Number(body.startingValue) || 0,
    progressSource: body.progressSource === "manual" ? "manual" : "auto",
    spendCapCategory: body.spendCapCategory || null,
    manualProgress: 0,
    notes: String(body.notes || "").trim(),
    createdAt: ts,
    updatedAt: ts,
  };
  await putItem(item);
  return json(201, item);
}

async function updateGoal(event, year, goalId) {
  const userId = await getUserId(event);
  assertWrite(await resolveCtxCached(event), "budget");
  const y = parseInt(year, 10);
  const assetId = `GOAL#${y}#${goalId}`;
  const existing = await getItem(userId, assetId);
  if (!existing) return notFound("Goal not found");

  const body = parseBody(event);
  const ts = now();
  const updated = {
    ...existing,
    name:           body.name?.trim()             || existing.name,
    targetAmount:   body.targetAmount != null      ? Math.round(Number(body.targetAmount) * 100) / 100 : existing.targetAmount,
    startingValue:  body.startingValue != null     ? Number(body.startingValue) : existing.startingValue,
    manualProgress: body.manualProgress != null    ? Number(body.manualProgress) : existing.manualProgress,
    notes:          body.notes != null             ? String(body.notes).trim() : existing.notes,
    progressSource: body.progressSource            || existing.progressSource,
    updatedAt: ts,
  };
  await putItem(updated);
  return json(200, updated);
}

async function deleteGoal(event, year, goalId) {
  const userId = await getUserId(event);
  assertWrite(await resolveCtxCached(event), "budget");
  const y = parseInt(year, 10);
  const assetId = `GOAL#${y}#${goalId}`;
  const existing = await getItem(userId, assetId);
  if (!existing) return notFound("Goal not found");
  const { deleteItem } = require("finvault-shared/ddb");
  await deleteItem(userId, assetId);
  return json(200, { deleted: true });
}

// ── Shared spending query (paginated) ─────────────────────────────────────────

// datePrefix examples: "2026-01-" for a single month, "2026-" for a full year.
// begins_with avoids boundary issues with any timestamp format stored in the date field.
async function fetchAllSpending(userId, datePrefix) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: SPENDING_TABLE,
      IndexName: DATE_INDEX_NAME,
      KeyConditionExpression: "userId = :uid AND begins_with(#dt, :prefix)",
      ExpressionAttributeNames: { "#dt": "date" },
      ExpressionAttributeValues: { ":uid": userId, ":prefix": datePrefix },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

// Safe date: cap dueDay at 28 to avoid Feb 30 etc.
function dateForDay(y, m, dueDay) {
  const d = Math.min(parseInt(dueDay, 10) || 1, 28);
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// Single source of truth for "has this item's due date passed?"
// Keeps the same logic that was previously duplicated on the frontend.
// - Past year / past month → always true
// - Future year / future month → always false
// - Current month → true only when today >= dueDay
function itemPastDue(item, y, m, today) {
  const ty = today.getFullYear(), tm = today.getMonth() + 1, td = today.getDate();
  if (y < ty || (y === ty && m < tm)) return true;
  if (y > ty || (y === ty && m > tm)) return false;
  return td >= (item.dueDay || 1);
}

async function listOutflows(event, year, month) {
  const userId = await getUserId(event);
  assertRead(await resolveCtxCached(event), "budget");
  const { y, m } = parseYearMonth(year, month);
  const today = new Date();

  // Fetch budget def + spending for this month in parallel
  const [budgetItem, spendingItems] = await Promise.all([
    getItem(userId, `BUDGET_DEF#${y}`),
    fetchAllSpending(userId, `${y}-${pad2(m)}-`),
  ]);

  const budgetDef = enrichBudgetDef(budgetItem) || defaultBudgetDef();

  // ── Extract override records keyed by budgetItemId ──
  const overrides = {};
  const cc        = [];

  for (const item of spendingItems) {
    if (item.source === "budget-recurring") continue;
    if (item.source === "budget-override" && item.budgetItemId) {
      overrides[item.budgetItemId] = item;
      continue;
    }
    const budgetCat = toBudgetCategory(item.category);
    if (isExcluded(budgetCat)) continue;
    cc.push({ ...item, budgetCategory: budgetCat });
  }

  cc.sort((a, b) => a.date.localeCompare(b.date));

  // ── Planned outflows from budget definition (enriched with overrides) ──
  // pastDue is computed here so the frontend doesn't need to replicate the logic.
  const planned = [];

  const makePlanned = (type, item) => {
    const budgetedAmount = item.amount ?? item.monthlyAmount ?? 0;
    const ov = overrides[item.id];
    return {
      type,
      itemId:        item.id,
      name:          item.name,
      budgetedAmount,
      actualAmount:  ov ? ov.amount : null,
      hasOverride:   !!ov,
      dueDay:        item.dueDay,
      frequency:     item.frequency || "monthly",
      dueMonth:      item.dueMonth,
      date:          dateForDay(y, m, item.dueDay),
      pastDue:       itemPastDue(item, y, m, today),
    };
  };

  for (const fe of budgetDef.fixedExpenses || []) {
    if (fe.frequency === "annual" && (fe.dueMonth || 1) !== m) continue;
    planned.push(makePlanned("fixed", fe));
  }
  for (const loan of budgetDef.loans || []) {
    planned.push(makePlanned("loan", loan));
  }
  for (const inv of budgetDef.investments || []) {
    planned.push(makePlanned("investment", inv));
  }

  planned.sort((a, b) => a.date.localeCompare(b.date));

  const r2 = n => Math.round(n * 100) / 100;
  const budgetedTotal = r2(planned.reduce((s, p) => s + p.budgetedAmount, 0));
  const actualsTotal  = r2(planned.reduce((s, p) => s + (p.actualAmount ?? p.budgetedAmount), 0));
  const ccTotal       = r2(cc.reduce((s, x) => s + x.amount, 0));

  return json(200, {
    planned,
    cc,
    summary: { budgetedTotal, actualsTotal, ccTotal },
  });
}

// ── Annual spend actuals (all months in one query) ────────────────────────────

async function getAnnualSpendActuals(event, year) {
  const userId = await getUserId(event);
  assertRead(await resolveCtxCached(event), "budget");
  const y = parseInt(year, 10);
  if (y < 2000 || y > 2100) return badRequest("Invalid year");

  // Fetch budget definition + full year spending in parallel
  const [budgetItem, allItems] = await Promise.all([
    getItem(userId, `BUDGET_DEF#${y}`),
    fetchAllSpending(userId, `${y}-`),
  ]);
  const budgetDef = enrichBudgetDef(budgetItem) || defaultBudgetDef();

  const byMonth = {};
  // budgetItemId#month → override amount (from explicit Cash Outflow actuals)
  const overrideByKey = {};
  const today = new Date();

  // First pass: CC transactions and override collection.
  for (const item of allItems) {
    const m = parseInt((item.date || "").slice(5, 7), 10);
    if (!m) continue;
    if (!byMonth[m]) byMonth[m] = { total: 0, cc: 0, planned: 0, byCategory: {} };
    const amt = Number(item.amount || 0);

    if (item.source === "budget-recurring") continue;
    if (item.source === "budget-override" && item.budgetItemId) {
      overrideByKey[`${item.budgetItemId}#${m}`] = amt;
      continue;
    }
    const cat = toBudgetCategory(item.category);
    if (isExcluded(cat)) continue;
    byMonth[m].cc    += amt;
    byMonth[m].total += amt;
    byMonth[m].byCategory[cat] = (byMonth[m].byCategory[cat] || 0) + amt;
  }

  // Second pass: for each past-due planned item use override amount if one was
  // recorded, otherwise fall back to budgeted amount — identical to what
  // Cash Outflows shows for past-due items, keeping both tabs in sync.
  for (let m = 1; m <= 12; m++) {
    const addPlannedItem = (item, type) => {
      if (type === "fixed" && item.frequency === "annual" && (item.dueMonth || 1) !== m) return;
      if (!itemPastDue(item, y, m, today)) return;

      if (!byMonth[m]) byMonth[m] = { total: 0, cc: 0, planned: 0, byCategory: {} };
      const budgeted = item.amount ?? item.monthlyAmount ?? 0;
      const actual   = overrideByKey[`${item.id}#${m}`] ?? budgeted;
      byMonth[m].planned += actual;
      byMonth[m].total   += actual;
    };

    for (const fe of budgetDef.fixedExpenses || []) addPlannedItem(fe, "fixed");
    for (const l  of budgetDef.loans         || []) addPlannedItem(l,  "loan");
    for (const iv of budgetDef.investments   || []) addPlannedItem(iv, "investment");
  }

  const r2 = n => Math.round(n * 100) / 100;
  for (const mx of Object.values(byMonth)) {
    mx.total   = r2(mx.total);
    mx.cc      = r2(mx.cc);
    mx.planned = r2(mx.planned);
    for (const k of Object.keys(mx.byCategory)) mx.byCategory[k] = r2(mx.byCategory[k]);
  }

  return json(200, { year: y, byMonth });
}

// ── Outflow overrides (actual vs planned for fixed/loan/investment items) ──────
// Stored in StoreReceiptLedger with source="budget-override" and a deterministic
// pk so they can be idempotently created/updated/deleted per budgetItemId + month.

async function putOutflowOverride(event, budgetItemId, year, month) {
  const userId = await getUserId(event);
  assertWrite(await resolveCtxCached(event), "budget");
  const { y, m } = parseYearMonth(year, month);
  const body = parseBody(event);

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) return badRequest("amount must be >= 0");

  const ts = now();
  const item = {
    pk: `OVERRIDE#${budgetItemId}#${y}-${pad2(m)}`,
    sk: "ITEM#001",
    userId,
    budgetItemId,
    date: dateForDay(y, m, body.dueDay || 1),
    amount: Math.round(amount * 100) / 100,
    source: "budget-override",
    year: y,
    month: m,
    updatedAt: ts,
  };

  await ddb.send(new PutCommand({ TableName: SPENDING_TABLE, Item: item }));
  return json(200, item);
}

async function deleteOutflowOverride(event, budgetItemId, year, month) {
  const userId = await getUserId(event);
  assertWrite(await resolveCtxCached(event), "budget");
  const { y, m } = parseYearMonth(year, month);

  try {
    await ddb.send(new DeleteCommand({
      TableName: SPENDING_TABLE,
      Key: { pk: `OVERRIDE#${budgetItemId}#${y}-${pad2(m)}`, sk: "ITEM#001" },
      ConditionExpression: "userId = :uid",
      ExpressionAttributeValues: { ":uid": userId },
    }));
  } catch (e) {
    if (e.name === "ConditionalCheckFailedException") return json(200, { deleted: false });
    throw e;
  }
  return json(200, { deleted: true });
}

// ── Router ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  try {
    const method = getMethod(event);
    const path   = getPath(event);

    // Strip /budget prefix then split segments
    const rel = path.replace(/^\/budget\/?/, "");
    const seg = rel.split("/").filter(Boolean);

    // OPTIONS preflight
    if (method === "OPTIONS") return json(200, {});

    // /budget/cc-actuals/{year}/{month}
    if (seg[0] === "cc-actuals" && seg[1] && seg[2]) {
      if (method === "GET") return await getCCActuals(event, seg[1], seg[2]);
    }

    // /budget/spend-actuals/{year}
    if (seg[0] === "spend-actuals" && seg[1] && !seg[2]) {
      if (method === "GET") return await getAnnualSpendActuals(event, seg[1]);
    }

    // /budget/outflow-override/{itemId}/{year}/{month}
    if (seg[0] === "outflow-override" && seg[1] && seg[2] && seg[3]) {
      if (method === "PUT")    return await putOutflowOverride(event, seg[1], seg[2], seg[3]);
      if (method === "DELETE") return await deleteOutflowOverride(event, seg[1], seg[2], seg[3]);
    }

    // /budget/definition/{year}
    if (seg[0] === "definition" && seg[1] && !seg[2]) {
      if (method === "GET")  return await getBudgetDefinition(event, seg[1]);
      if (method === "PUT")  return await putBudgetDefinition(event, seg[1]);
    }

    // /budget/definition/{year}/{month}
    if (seg[0] === "definition" && seg[1] && seg[2]) {
      if (method === "GET")    return await getBudgetDefinition(event, seg[1], seg[2]);
      if (method === "PUT")    return await putBudgetDefinition(event, seg[1], seg[2]);
      if (method === "DELETE") return await deleteBudgetOverride(event, seg[1], seg[2]);
    }

    // /budget/income/{year}
    if (seg[0] === "income" && seg[1]) {
      if (method === "GET") return await getIncome(event, seg[1]);
      if (method === "PUT") return await putIncome(event, seg[1]);
    }

    // /budget/goals/{year}
    if (seg[0] === "goals" && seg[1] && !seg[2]) {
      if (method === "GET")  return await listGoals(event, seg[1]);
      if (method === "POST") return await createGoal(event, seg[1]);
    }

    // /budget/goals/{year}/{goalId}
    if (seg[0] === "goals" && seg[1] && seg[2]) {
      if (method === "PATCH")  return await updateGoal(event, seg[1], seg[2]);
      if (method === "DELETE") return await deleteGoal(event, seg[1], seg[2]);
    }

    // /budget/outflows/{year}/{month}
    if (seg[0] === "outflows" && seg[1] && seg[2] && !isNaN(seg[1]) && !isNaN(seg[2])) {
      if (method === "GET") return await listOutflows(event, seg[1], seg[2]);
    }

    return json(404, { error: "Not found" });
  } catch (err) {
    console.error("BudgetApi error:", err.message, err.stack);
    if (err.statusCode === 401) return json(401, { error: err.message });
    if (err.statusCode === 403 || err.message?.startsWith("Forbidden")) return json(403, { error: err.message });
    if (err.message?.includes("Invalid") || err.message?.includes("required")) {
      return badRequest(err.message);
    }
    return json(500, { error: err.message || "Internal server error" });
  }
};
