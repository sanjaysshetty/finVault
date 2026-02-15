import { Fragment, useEffect, useMemo, useState } from "react";

const THEME = {
  pageText: "#CBD5F5",
  title: "#F9FAFB",
  muted: "#94A3B8",
  panelBg: "rgba(15, 23, 42, 0.65)",
  panelBorder: "rgba(148, 163, 184, 0.16)",
  rowBorder: "rgba(148, 163, 184, 0.12)",
  inputBg: "rgba(2, 6, 23, 0.45)",
  inputBorder: "rgba(148, 163, 184, 0.18)",
  primaryBg: "rgba(99, 102, 241, 0.18)",
  primaryBorder: "rgba(99, 102, 241, 0.45)",
  dangerBg: "rgba(239, 68, 68, 0.12)",
  dangerBorder: "rgba(239, 68, 68, 0.35)",

  // Section headers (Assets / Liabilities)
  assetsSectionBg: "rgba(34, 197, 94, 0.18)",
  assetsSectionBorder: "rgba(34, 197, 94, 0.45)",
  assetsSectionText: "#BBF7D0",

  liabsSectionBg: "rgba(239, 68, 68, 0.14)",
  liabsSectionBorder: "rgba(239, 68, 68, 0.38)",
  liabsSectionText: "#FECACA",

  badgeBg: "rgba(148, 163, 184, 0.10)",
  badgeBorder: "rgba(148, 163, 184, 0.25)",
};

/* ---------------- utils ---------------- */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function round2(n) {
  return Math.round(safeNum(n, 0) * 100) / 100;
}

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

/* ---------------- API helpers ---------------- */

function getApiBase() {
  const envBase = (import.meta.env.VITE_API_BASE_URL || "").trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const winBase = (window.__FINVAULT_API_BASE_URL || "").trim?.() || "";
  if (winBase) return winBase.replace(/\/+$/, "");
  return "";
}

function getAccessToken() {
  return (
    sessionStorage.getItem("finvault.accessToken") ||
    sessionStorage.getItem("access_token") ||
    ""
  );
}

async function apiFetch(path, { method = "GET", body } = {}) {
  const base = getApiBase();
  if (!base) throw new Error("Missing API base. Set VITE_API_BASE_URL in .env");

  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const token = getAccessToken();

  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  const text = await res.text().catch(() => "");
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return data;
}

/* ---------------- formatting ---------------- */

function formatMoney(n, currency = "USD") {
  const x = safeNum(n, 0);
  try {
    return x.toLocaleString(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } catch {
    return `$${x.toFixed(2)}`;
  }
}

/* ---------------- UI primitives ---------------- */

function Card({ children, style }) {
  return (
    <div
      style={{
        background: THEME.panelBg,
        border: `1px solid ${THEME.panelBorder}`,
        borderRadius: 14,
        padding: 12,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function extractItems(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.items)) return res.items;
  return [];
}

function extractCryptoSpots(pricesRes) {
  const crypto = pricesRes?.crypto;
  if (!crypto) return {};

  // Possible shapes:
  // 1) { results: [ {...}, ... ] }  (common)
  // 2) { data: [ {...}, ... ] }
  // 3) [ {...}, ... ]
  // 4) { "BTC-USD": {...} } or { "BTC-USD": 43000.12 }
  const arr = Array.isArray(crypto)
    ? crypto
    : Array.isArray(crypto?.results)
    ? crypto.results
    : Array.isArray(crypto?.data)
    ? crypto.data
    : null;

  const out = {};

  const writeSpot = (sym, spot) => {
    const s = String(sym || "").toUpperCase().trim();
    if (!s) return;

    const val = safeNum(spot, 0);
    if (!(val > 0)) return;

    // Dynamic precision so tiny coins don't render as 0.00
    const abs = Math.abs(val);
    const fixed = abs > 0 && abs < 0.01 ? 10 : abs > 0 && abs < 1 ? 6 : 2;
    out[s] = Number(val.toFixed(fixed));
  };

  const readOne = (obj, fallbackSym = "") => {
    const sym = obj?.symbol || obj?.instrument_id || obj?.pair || fallbackSym || "";
    if (!sym) return;

    // Some APIs return a direct number (spot)
    if (typeof obj === "number") {
      writeSpot(sym, obj);
      return;
    }

    // Allow direct numeric "price/last/mid"
    const direct =
      (typeof obj?.price === "number" ? obj.price : NaN) ||
      (typeof obj?.last === "number" ? obj.last : NaN) ||
      (typeof obj?.mid === "number" ? obj.mid : NaN);

    if (Number.isFinite(direct) && direct > 0) {
      writeSpot(sym, direct);
      return;
    }

    const bid = safeNum(obj?.bid, NaN);
    const ask = safeNum(obj?.ask, NaN);

    const bid2 = safeNum(obj?.bid_inclusive_of_sell_spread, NaN);
    const ask2 = safeNum(obj?.ask_inclusive_of_buy_spread, NaN);

    const b = Number.isFinite(bid) ? bid : Number.isFinite(bid2) ? bid2 : NaN;
    const a = Number.isFinite(ask) ? ask : Number.isFinite(ask2) ? ask2 : NaN;

    let spot = 0;
    if (Number.isFinite(b) && Number.isFinite(a) && b > 0 && a > 0) spot = (b + a) / 2;
    else if (Number.isFinite(a) && a > 0) spot = a;
    else if (Number.isFinite(b) && b > 0) spot = b;

    writeSpot(sym, spot);
  };

  if (arr) {
    arr.forEach((obj) => readOne(obj));
    return out;
  }

  if (typeof crypto === "object") {
    Object.entries(crypto).forEach(([sym, obj]) => {
      if (obj === null || obj === undefined) return;
      if (typeof obj === "number") {
        writeSpot(sym, obj);
        return;
      }
      readOne(obj, sym);
    });
  }

  return out;
}

function getCryptoSpot(spotMap, sym) {
  if (!spotMap || !sym) return 0;
  const key = String(sym).toUpperCase().trim();

  const direct = safeNum(spotMap[key], NaN);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const noUsd = key.replace(/-USD$/i, "");
  const v1 = safeNum(spotMap[noUsd], NaN);
  if (Number.isFinite(v1) && v1 > 0) return v1;

  const withDash = noUsd.includes("-") ? noUsd : `${noUsd}-USD`;
  const v2 = safeNum(spotMap[withDash], NaN);
  if (Number.isFinite(v2) && v2 > 0) return v2;

  const noDash = key.replace(/-/g, "");
  const v3 = safeNum(spotMap[noDash], NaN);
  if (Number.isFinite(v3) && v3 > 0) return v3;

  return 0;
}

function computeBullionHolding(transactions, spot) {
  const state = {
    GOLD: { qty: 0, cost: 0, avg: 0 },
    SILVER: { qty: 0, cost: 0, avg: 0 },
  };

  const txs = [...(transactions || [])].sort((a, b) =>
    String(a.date || "").localeCompare(String(b.date || ""))
  );

  for (const t of txs) {
    const metal = String(t.metal || "GOLD").toUpperCase();
    const type = String(t.type || "BUY").toUpperCase();
    if (!state[metal]) continue;

    const qty = safeNum(t.quantityOz, 0);
    const price = safeNum(t.unitPrice, 0);
    const fees = safeNum(t.fees, 0);
    const s = state[metal];

    if (type === "BUY") {
      const addCost = qty * price + fees;
      s.qty += qty;
      s.cost += addCost;
      s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    } else if (type === "SELL") {
      const sellQty = Math.min(qty, s.qty);
      const basis = sellQty * (s.avg || 0);
      s.qty -= sellQty;
      s.cost -= basis;
      s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    }
  }

  const goldSpot = safeNum(spot?.GOLD, 0);
  const silverSpot = safeNum(spot?.SILVER, 0);
  return round2(state.GOLD.qty * goldSpot + state.SILVER.qty * silverSpot);
}

function computeStocksHolding(transactions, quoteMap) {
  const bySymbol = {};
  const txs = [...(transactions || [])].sort((a, b) =>
    String(a.date || "").localeCompare(String(b.date || ""))
  );

  for (const t of txs) {
    const symbol = String(t.symbol || "").toUpperCase().trim();
    if (!symbol) continue;
    const type = String(t.type || "BUY").toUpperCase();
    const shares = safeNum(t.shares, 0);
    const price = safeNum(t.price, 0);
    const fees = safeNum(t.fees, 0);

    if (!bySymbol[symbol]) bySymbol[symbol] = { shares: 0, cost: 0, avg: 0 };
    const s = bySymbol[symbol];

    if (type === "BUY") {
      const addCost = shares * price + fees;
      s.shares += shares;
      s.cost += addCost;
      s.avg = s.shares > 0 ? s.cost / s.shares : 0;
    } else if (type === "SELL") {
      const sellShares = Math.min(shares, s.shares);
      const basis = sellShares * (s.avg || 0);
      s.shares -= sellShares;
      s.cost -= basis;
      s.avg = s.shares > 0 ? s.cost / s.shares : 0;
    }
  }

  let holdingValue = 0;
  for (const [sym, s] of Object.entries(bySymbol)) {
    const spot = safeNum(quoteMap?.[sym]?.price, 0);
    holdingValue += s.shares * spot;
  }
  return round2(holdingValue);
}

function computeCryptoHolding(transactions, spotMap) {
  const bySym = {};
  const txs = [...(transactions || [])].sort((a, b) =>
    String(a.date || "").localeCompare(String(b.date || ""))
  );

  for (const t of txs) {
    let sym = String(t.symbol || "").toUpperCase().trim();
    if (!sym) continue;
    if (!sym.includes("-")) sym = `${sym}-USD`;

    const type = String(t.type || "BUY").toUpperCase();
    const qty = safeNum(t.quantity, 0);
    const px = safeNum(t.unitPrice, 0);
    const fees = safeNum(t.fees, 0);

    if (!bySym[sym]) bySym[sym] = { qty: 0, cost: 0, avg: 0 };
    const s = bySym[sym];

    if (type === "BUY") {
      const addCost = qty * px + fees;
      s.qty += qty;
      s.cost += addCost;
      s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    } else if (type === "SELL") {
      const sellQty = Math.min(qty, s.qty);
      const basis = sellQty * (s.avg || 0);
      s.qty -= sellQty;
      s.cost -= basis;
      s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    }
  }

  let holdingValue = 0;
  for (const [sym, s] of Object.entries(bySym)) {
    const spot = getCryptoSpot(spotMap, sym);
    holdingValue += s.qty * spot;
  }
  return round2(holdingValue);
}

function fixedIncomeValue(it) {
  // Support multiple backend schemas; prefer explicit current/market value fields.
  const candidates = [
    it?.currentValue,
    it?.marketValue,
    it?.value,
    it?.amount,
    it?.balance,
    it?.principal,
    it?.faceValue,
  ];
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}



function SectionHeader({ title, variant = "assets", style }) {
  const isLiab = variant === "liabilities";
  const bg = isLiab ? THEME.liabsSectionBg : THEME.assetsSectionBg;
  const border = isLiab ? THEME.liabsSectionBorder : THEME.assetsSectionBorder;
  const color = isLiab ? THEME.liabsSectionText : THEME.assetsSectionText;

  return (
    <div
      style={{
        background: bg,
        border: `1px solid ${border}`,
        color,
        borderRadius: 0,        // sharp section header box
        padding: "9px 12px",
        fontWeight: 950,
        fontSize: 14,
        marginTop: 10,
        marginBottom: 6,
        ...style,
      }}
    >
      {title}
    </div>
  );
}


function Table({ columns, rows, footer, showHeader = true, rowBorderColor }) {
  const rb = rowBorderColor || THEME.rowBorder;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        {showHeader ? (
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  style={{
                    textAlign: c.align || "left",
                    fontSize: 12,
                    fontWeight: 900,
                    color: THEME.muted,
                    padding: "8px 10px",
                    borderBottom: `1px solid ${rb}`,
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  style={{
                    padding: "8px 10px",
                    borderBottom: `1px solid ${rb}`,
                    fontSize: 13,
                    color: THEME.pageText,
                    textAlign: c.align || "left",
                    whiteSpace: c.noWrap ? "nowrap" : "normal",
                    verticalAlign: "top",
                  }}
                >
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}


function Button({ children, onClick, kind = "primary" }) {
  const bg = kind === "danger" ? THEME.dangerBg : THEME.primaryBg;
  const br = kind === "danger" ? THEME.dangerBorder : THEME.primaryBorder;
  return (
    <button
      onClick={onClick}
      style={{
        background: bg,
        border: `1px solid ${br}`,
        color: THEME.title,
        borderRadius: 10,
        padding: "8px 10px",
        fontWeight: 800,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function GhostButton({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        border: `1px solid ${THEME.inputBorder}`,
        color: THEME.pageText,
        borderRadius: 10,
        padding: "8px 10px",
        fontWeight: 800,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

/* ---------------- Liabilities (API-based) ---------------- */

function normalizeLiabilityItem(it) {
  const c = String(it?.country || "").trim().toUpperCase();
  const country = c === "INDIA" || c === "IN" ? "INDIA" : "USA";
  return {
    id: it?.liabilityId || it?.assetId || it?.id || uid("lb"),
    country,
    category: String(it?.category || "Other"),
    description: String(it?.description || ""),
    value: safeNum(it?.value, 0),
    remarks: String(it?.remarks || ""),
  };
}

function buildLiabilitiesSections(items, country) {
  const list = (items || []).filter((it) => pickCountry(it) === country);

  // Group by category
  const map = new Map();
  for (const it of list) {
    const cat = String(it?.category || "Other").trim() || "Other";
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(it);
  }

  // Stable alphabetical section order
  const sections = Array.from(map.entries())
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([title, arr]) => ({
      title,
      rows: arr.map((it) => ({
        id: it.id,
        label: it.description || "Liability",
        amount: safeNum(it.value, 0),
        remarks: it.remarks || "",
      })),
    }));

  return sections;
}

function LiabilitiesCard({ items, currency, country }) {
  const redBorder = THEME.liabsSectionBorder;
  const redLine = "rgba(239, 68, 68, 0.22)";

  const sections = buildLiabilitiesSections(items, country);

  const totalLiabs = round2(
    (items || [])
      .filter((it) => pickCountry(it) === country)
      .reduce((s, it) => s + safeNum(it.value, 0), 0)
  );

  return (
    <Card
      style={{
        border: `1px solid ${redBorder}`,
      }}
    >
      {/* Card header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <div style={{ fontWeight: 900, color: THEME.title, fontSize: 16 }}>Liabilities</div>
        <div style={{ flex: 1 }} />
        <div style={{ fontWeight: 900, color: THEME.title, fontSize: 16 }}>
          {formatMoney(totalLiabs, currency)}
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <colgroup>
            <col style={{ width: "44%" }} />
            <col style={{ width: "26%" }} />
            <col style={{ width: "30%" }} />
          </colgroup>

          <tbody>
            {sections.length ? (
              sections.map((sec) => {
                const secTotal = round2(sec.rows.reduce((s, r) => s + safeNum(r.amount, 0), 0));
                return (
                  <Fragment key={sec.title}>
                    {/* Section header row (sharp edges, total inside header) */}
                    <tr>
                      <td colSpan={3} style={{ padding: 0, borderBottom: `1px solid ${redLine}` }}>
                        <div
                          style={{
                            background: THEME.liabsSectionBg,
                            border: `1px solid ${redBorder}`,
                            borderRadius: 0,
                            padding: "9px 12px",
                            color: THEME.liabsSectionText,
                            fontWeight: 950,
                            fontSize: 14,
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                          }}
                        >
                          <div style={{ flex: 1 }}>{sec.title}</div>
                          <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                            {formatMoney(secTotal, currency)}
                          </div>
                        </div>
                      </td>
                    </tr>

                    {/* Section rows */}
                    {sec.rows.map((r) => (
                      <tr key={r.id}>
                        <td
                          style={{
                            padding: "8px 10px",
                            borderBottom: `1px solid ${redLine}`,
                            fontSize: 13,
                            color: THEME.pageText,
                            verticalAlign: "top",
                          }}
                        >
                          {r.label}
                        </td>
                        <td
                          style={{
                            padding: "8px 10px",
                            borderBottom: `1px solid ${redLine}`,
                            fontSize: 13,
                            color: THEME.pageText,
                            textAlign: "right",
                            whiteSpace: "nowrap",
                            verticalAlign: "top",
                          }}
                        >
                          {formatMoney(r.amount, currency)}
                        </td>
                        <td
                          style={{
                            padding: "8px 10px",
                            borderBottom: `1px solid ${redLine}`,
                            fontSize: 13,
                            color: THEME.pageText,
                            verticalAlign: "top",
                          }}
                        >
                          {r.remarks || ""}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })
            ) : (
              <tr>
                <td style={{ padding: "10px", color: THEME.muted, fontSize: 12 }} colSpan={3}>
                  No liabilities found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}


/* ---------------- Assets builder (fixed sections) ---------------- */

const OTHER_SECTION_ORDER = [
  { key: "ROBO", title: "Robo Investment Account" },
  { key: "EDUCATION", title: "Education" },
  { key: "RETIREMENT", title: "Retirement" },
  { key: "PROPERTY", title: "Property" },
];

function pickCountry(item) {
  const c = String(item?.country || item?.region || "").trim().toUpperCase();
  if (c === "USA" || c === "US") return "USA";
  if (c === "INDIA" || c === "IN") return "INDIA";
  return "USA";
}

function buildAssetsRows({ stocksTotal, bullionTotal, cryptoTotal, fixedIncomeItems, otherAssetsItems, country }) {
  const rows = [];

  rows.push({ kind: "section", id: "sec_mkt", label: "Market Traded Assets" });
  rows.push({ kind: "row", id: "mkt_stocks", label: "Stocks", amount: stocksTotal, remarks: "Synced from Stocks" });
  rows.push({ kind: "row", id: "mkt_bullion", label: "Bullion", amount: bullionTotal, remarks: "Synced from Bullion" });
  rows.push({ kind: "row", id: "mkt_crypto", label: "Crypto", amount: cryptoTotal, remarks: "Synced from Crypto" });

  const otherForCountry = (otherAssetsItems || []).filter((it) => pickCountry(it) === country);

  // ---- Options (summarized from Other Assets) ----
  // Include ONLY assetType OTHER_ASSET and categoryKey OPTIONS (robust to different field names).
  const optionsItems = otherForCountry.filter((it) => {
    const assetType = String(it?.assetType || it?.assettype || it?.type || "OTHER_ASSET")
      .trim()
      .toUpperCase();
    const catKey = String(it?.categoryKey || it?.category || it?.category_name || "")
      .trim()
      .toUpperCase();
    return assetType === "OTHER_ASSET" && catKey === "OPTIONS";
  });

  const optionsTotal = round2(
    optionsItems.reduce((s, it) => s + safeNum(it?.value ?? it?.assetValue, 0), 0)
  );

  const optionsRemarks = optionsItems
    .map((it) => String(it?.description || it?.label || "").trim())
    .filter(Boolean)
    // de-dupe while preserving order
    .filter((d, i, arr) => arr.indexOf(d) === i)
    .join("; ");

  rows.push({
    kind: "row",
    id: "mkt_options",
    label: "Options",
    amount: optionsTotal,
    remarks: optionsRemarks,
  });

  const byCat = new Map();
  for (const it of otherForCountry) {
    const key = String(it?.categoryKey || it?.category || "").trim().toUpperCase();
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(it);
  }

  for (const sec of OTHER_SECTION_ORDER) {
    rows.push({ kind: "section", id: `sec_${sec.key}`, label: sec.title });
    const items = byCat.get(sec.key) || [];
    for (const it of items) {
      rows.push({
        kind: "row",
        id: it.assetId || it.id || uid("oa"),
        label: String(it.description || it.label || "Other Asset"),
        amount: safeNum(it.value ?? it.assetValue, 0),
        remarks: "",
      });
    }
  }

  const cashItems = byCat.get("CASH") || [];
  if (cashItems.length) {
    // append cash under Property
    for (const it of cashItems) {
      rows.push({
        kind: "row",
        id: it.assetId || it.id || uid("cash"),
        label: String(it.description || it.label || "Cash"),
        amount: safeNum(it.value ?? it.assetValue, 0),
        remarks: "",
      });
    }
  }

  rows.push({ kind: "section", id: "sec_fixed", label: "Fixed Income" });
  const fiForCountry = (fixedIncomeItems || []).filter((it) => pickCountry(it) === country);
  for (const it of fiForCountry) {
    rows.push({
      kind: "row",
      id: it.assetId || it.id || uid("fi"),
      label: String(it.description || it.label || it.name || "Fixed Income"),
      amount: fixedIncomeValue(it),
      remarks: String(it.remarks || ""),
    });
  }

  return rows;
}


function sumAssetRows(rows) {
  return round2((rows || []).filter((r) => r.kind === "row").reduce((s, r) => s + safeNum(r.amount, 0), 0));
}


function AssetsCard({ rows, currency }) {
  const greenBorder = THEME.assetsSectionBorder;
  const greenLine = "rgba(34, 197, 94, 0.28)";

  // Group rows by section and compute totals
  const sections = [];
  let current = null;
  for (const r of rows || []) {
    if (r.kind === "section") {
      if (current) sections.push(current);
      current = { title: r.label, rows: [] };
    } else {
      if (!current) current = { title: "Assets", rows: [] };
      current.rows.push(r);
    }
  }
  if (current) sections.push(current);

  const totalAssets = round2(
    (rows || []).filter((r) => r.kind === "row").reduce((s, r) => s + safeNum(r.amount, 0), 0)
  );

  return (
    <Card
      style={{
        border: `1px solid ${greenBorder}`,
      }}
    >
      {/* Card header (no separate Assets section outside) */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <div style={{ fontWeight: 900, color: THEME.title, fontSize: 16 }}>Assets</div>
        <div style={{ flex: 1 }} />
        <div style={{ fontWeight: 900, color: THEME.title, fontSize: 16 }}>
          {formatMoney(totalAssets, currency)}
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          {/* Force vertical alignment across ALL sections */}
          <colgroup>
            <col style={{ width: "44%" }} />
            <col style={{ width: "26%" }} />
            <col style={{ width: "30%" }} />
          </colgroup>

          <tbody>
            {sections.map((sec) => {
              const secTotal = round2(sec.rows.reduce((s, r) => s + safeNum(r.amount, 0), 0));
              return (
                <Fragment key={sec.title}>
                  {/* Section header row (sharp edges, total inside header, right aligned) */}
                  <tr>
                    <td colSpan={3} style={{ padding: 0, borderBottom: `1px solid ${greenLine}` }}>
                      <div
                        style={{
                          background: THEME.assetsSectionBg,
                          border: `1px solid ${greenBorder}`,
                          borderRadius: 0, // sharp edges
                          padding: "9px 12px",
                          color: THEME.assetsSectionText,
                          fontWeight: 950,
        fontSize: 14,
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <div style={{ flex: 1 }}>{sec.title}</div>
                        <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          {formatMoney(secTotal, currency)}
                        </div>
                      </div>
                    </td>
                  </tr>

                  {/* Section rows */}
                  {sec.rows.map((r) => (
                    <tr key={r.id}>
                      <td
                        style={{
                          padding: "8px 10px",
                          borderBottom: `1px solid ${greenLine}`,
                          fontSize: 13,
                          color: THEME.pageText,
                          verticalAlign: "top",
                        }}
                      >
                        {r.label}
                      </td>
                      <td
                        style={{
                          padding: "8px 10px",
                          borderBottom: `1px solid ${greenLine}`,
                          fontSize: 13,
                          color: THEME.pageText,
                          textAlign: "right",
                          whiteSpace: "nowrap",
                          verticalAlign: "top",
                        }}
                      >
                        {formatMoney(r.amount, currency)}
                      </td>
                      <td
                        style={{
                          padding: "8px 10px",
                          borderBottom: `1px solid ${greenLine}`,
                          fontSize: 13,
                          color: THEME.pageText,
                          verticalAlign: "top",
                        }}
                      >
                        {r.remarks || ""}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}


/* ---------------- Main NAV ---------------- */

export default function NAV() {
  const [filter, setFilter] = useState("ALL"); // ALL | USA | INDIA

  const [liabilitiesItems, setLiabilitiesItems] = useState([]);

  const [stocksTotal, setStocksTotal] = useState(0);
  const [bullionTotal, setBullionTotal] = useState(0);
  const [cryptoTotal, setCryptoTotal] = useState(0);
  const [fixedIncomeItems, setFixedIncomeItems] = useState([]);
  const [otherAssetsItems, setOtherAssetsItems] = useState([]);

  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  const showUSA = filter === "ALL" || filter === "USA";
  const showINDIA = filter === "ALL" || filter === "INDIA";

  useEffect(() => {
    (async () => {
      setLoading(true);
      setStatus("Loading…");
      try {
        const [liabsRes, fi, oa, stockRes, bullRes, cryptoRes] = await Promise.all([
          apiFetch("/liabilities").catch(() => []),
          apiFetch("/assets/fixedincome").catch(() => []),
          apiFetch("/assets/otherassets").catch(() => []),
          apiFetch("/assets/stocks/transactions").catch(() => []),
          apiFetch("/assets/bullion/transactions").catch(() => []),
          apiFetch("/assets/crypto/transactions").catch(() => []),
        ]);

        const liabsList = extractItems(liabsRes).map(normalizeLiabilityItem);
        setLiabilitiesItems(liabsList);

        setFixedIncomeItems(Array.isArray(fi) ? fi : (fi?.items || []));
        setOtherAssetsItems(Array.isArray(oa) ? oa : (oa?.items || []));

        const stockTx = extractItems(stockRes);
        const bullTx = extractItems(bullRes);
        const cryptoTx = extractItems(cryptoRes);

        // Prices for stocks + crypto + metals (same approach as Portfolio.jsx)
        const stockSymbols = Array.from(
          new Set(stockTx.map((t) => String(t.symbol || "").toUpperCase().trim()).filter(Boolean))
        ).sort();
        const cryptoSymbols = Array.from(
          new Set(
            cryptoTx
              .map((t) => String(t.symbol || "").toUpperCase().trim())
              .filter(Boolean)
              .map((s) => (s.includes("-") ? s : `${s}-USD`))
          )
        ).sort();

        const qsParts = [];
        if (stockSymbols.length) qsParts.push(`stocks=${encodeURIComponent(stockSymbols.join(","))}`);
        if (cryptoSymbols.length) qsParts.push(`crypto=${encodeURIComponent(cryptoSymbols.join(","))}`);
        const qs = qsParts.length ? `?${qsParts.join("&")}` : "";

        const pricesRes = await apiFetch(`/prices${qs}`).catch(() => ({}));

        const spot = {
          GOLD: round2(safeNum(pricesRes?.gold?.price, 0)),
          SILVER: round2(safeNum(pricesRes?.silver?.price, 0)),
        };
        const quoteMap = (pricesRes?.stocks && typeof pricesRes.stocks === "object") ? pricesRes.stocks : {};
        const cryptoSpots = extractCryptoSpots(pricesRes);

        setStocksTotal(computeStocksHolding(stockTx, quoteMap));
        setBullionTotal(computeBullionHolding(bullTx, spot));
        setCryptoTotal(computeCryptoHolding(cryptoTx, cryptoSpots));

        setStatus("");
      } catch (e) {
        console.error(e);
        setStatus(e.message || "Failed to load");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const usaAssetsRows = useMemo(
    () =>
      buildAssetsRows({
        stocksTotal,
        bullionTotal,
        cryptoTotal,
        fixedIncomeItems,
        otherAssetsItems,
        country: "USA",
      }),
    [stocksTotal, bullionTotal, cryptoTotal, fixedIncomeItems, otherAssetsItems]
  );

  const indiaAssetsRows = useMemo(
    () =>
      buildAssetsRows({
        stocksTotal: 0,
        bullionTotal: 0,
        cryptoTotal: 0,
        fixedIncomeItems,
        otherAssetsItems,
        country: "INDIA",
      }),
    [fixedIncomeItems, otherAssetsItems]
  );

  const usaAssetsTotal = useMemo(() => sumAssetRows(usaAssetsRows), [usaAssetsRows]);
  const indiaAssetsTotal = useMemo(() => sumAssetRows(indiaAssetsRows), [indiaAssetsRows]);
  const usaLiabsTotal = useMemo(
    () =>
      round2(
        liabilitiesItems
          .filter((it) => pickCountry(it) === "USA")
          .reduce((s, it) => s + safeNum(it.value, 0), 0)
      ),
    [liabilitiesItems]
  );

  const indiaLiabsTotal = useMemo(
    () =>
      round2(
        liabilitiesItems
          .filter((it) => pickCountry(it) === "INDIA")
          .reduce((s, it) => s + safeNum(it.value, 0), 0)
      ),
    [liabilitiesItems]
  );

  const usaNet = round2(usaAssetsTotal - usaLiabsTotal);
  const indiaNet = round2(indiaAssetsTotal - indiaLiabsTotal);

  function Region({ currency, assetsRows, country, liabilitiesItems }) {
    return (
      <div style={{ marginTop: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <AssetsCard rows={assetsRows} currency={currency} />
          </div>
          <div>
            <LiabilitiesCard items={liabilitiesItems} currency={currency} country={country} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, color: THEME.pageText }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 18, fontWeight: 950, color: THEME.title }}>Net Asset Value</div>
        <div style={{ flex: 1 }} />

        {/* Country filter (top-right) */}
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{
            background: THEME.inputBg,
            color: THEME.pageText,
            border: `1px solid ${THEME.inputBorder}`,
            borderRadius: 10,
            padding: "8px 10px",
            fontWeight: 800,
          }}
        >
          <option value="ALL">All</option>
          <option value="USA">USA</option>
          <option value="INDIA">India</option>
        </select>
      </div>

      {status ? <div style={{ marginBottom: 10, color: THEME.muted, fontSize: 12 }}>{status}</div> : null}

      {showUSA ? (
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, marginBottom: 14 }}>
        <Card>
          <div style={{ fontWeight: 900, color: THEME.title }}>Total USA Networth</div>
          <div style={{ marginTop: 6, fontSize: 20, fontWeight: 950, color: THEME.title }}>
            {showUSA ? formatMoney(usaNet, "USD") : "—"}
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: THEME.muted }}>
            {showUSA
              ? `Assets ${formatMoney(usaAssetsTotal, "USD")} • Liabilities ${formatMoney(usaLiabsTotal, "USD")}`
              : "Filter to USA or All"}
          </div>
        </Card>
      </div>
      ) : null}

      {showUSA ? (
        <Region
          currency="USD"
          assetsRows={usaAssetsRows}
          country="USA"
          liabilitiesItems={liabilitiesItems}
        />
      ) : null}

      {showINDIA ? (
        <div style={{ marginTop: 16 }}>
          {/* India total card is shown right before India sections */}
          <Card style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 900, color: THEME.title }}>Total India Networth</div>
            <div style={{ marginTop: 6, fontSize: 20, fontWeight: 950, color: THEME.title }}>
              {formatMoney(indiaNet, "USD")}
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: THEME.muted }}>
              {`Assets ${formatMoney(indiaAssetsTotal, "USD")} • Liabilities ${formatMoney(indiaLiabsTotal, "USD")}`}
            </div>
          </Card>

          <Region
            currency="USD"
            assetsRows={indiaAssetsRows}
            country="INDIA"
            liabilitiesItems={liabilitiesItems}
          />
        </div>
      ) : null}
    </div>
  );
}