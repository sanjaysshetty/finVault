/**
 * finVault shared formatting & math utilities.
 * Single source of truth — import from here instead of duplicating per page.
 */

// ── Number helpers ────────────────────────────────────────────

/** Parse value safely, returning fallback (default 0) on NaN/null/undefined */
export function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function round2(n) {
  return Math.round(safeNum(n) * 100) / 100;
}

export function round4(n) {
  return Math.round(safeNum(n) * 10000) / 10000;
}

// ── Currency formatting ───────────────────────────────────────

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const USD4 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

export function formatMoney(v) {
  return USD.format(safeNum(v));
}

export function formatMoney4(v) {
  return USD4.format(safeNum(v));
}

export function formatNum(v, decimals = 2) {
  return safeNum(v).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatPct(v) {
  const n = safeNum(v);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

// ── Color helpers ────────────────────────────────────────────

/** Tailwind class for positive = green, negative = red, zero = muted */
export function plColorClass(v) {
  const n = safeNum(v);
  if (n > 0) return "text-green-400";
  if (n < 0) return "text-red-400";
  return "text-slate-500";
}

/** Inline style color (for pages not yet migrated to Tailwind) */
export function plColor(v) {
  const n = safeNum(v);
  if (n > 0) return "#4ADE80";  // green-400
  if (n < 0) return "#F87171";  // red-400
  return "#64748B";              // slate-500
}

/** Arrow indicator for price change */
export function changeArrow(v) {
  return safeNum(v) >= 0 ? "▲" : "▼";
}

// ── Spot-price move helper ───────────────────────────────────

/**
 * Given a raw price object from the /prices endpoint,
 * returns { spot, prevClose, change, changePct, hasPrev }.
 *
 * Works for any normalized price object: { price, prevClose, change, changePct }
 */
export function spotMove(priceObj) {
  if (!priceObj) return { spot: null, prevClose: null, change: null, changePct: null, hasPrev: false };

  const spot      = safeNum(priceObj.price      ?? priceObj.spot, null);
  const prevClose = safeNum(priceObj.prevClose   ?? priceObj.prev_close_price, null);

  // Prefer pre-computed change fields; fall back to deriving from spot/prevClose
  let change    = priceObj.change    != null ? safeNum(priceObj.change)    : null;
  let changePct = priceObj.changePct != null ? safeNum(priceObj.changePct) : null;

  if (change == null && spot != null && prevClose != null) {
    change = round2(spot - prevClose);
  }
  if (changePct == null && change != null && prevClose != null && prevClose !== 0) {
    changePct = round2((change / prevClose) * 100);
  }

  return {
    spot,
    prevClose,
    change,
    changePct,
    hasPrev: prevClose != null,
  };
}
