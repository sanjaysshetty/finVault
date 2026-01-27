import { useEffect, useMemo, useState } from "react";

/* ---------------- Theme ---------------- */

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
};

function safeNum(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function round2(n) {
  return Number(safeNum(n, 0).toFixed(2));
}

function formatMoney(n) {
  const x = safeNum(n, 0);
  return x.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/* ---------------- API (same as other pages) ---------------- */

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
    throw new Error(`API returned non-JSON (${res.status})`);
  }

  if (!res.ok) {
    throw new Error(data?.error || data?.message || `Request failed (${res.status})`);
  }

  return data;
}

/* ---------------- Domain calcs ---------------- */

function computeBullion(transactions, spot) {
  const state = {
    GOLD: { qty: 0, cost: 0, avg: 0, realized: 0 },
    SILVER: { qty: 0, cost: 0, avg: 0, realized: 0 },
  };

  const txs = [...transactions].sort((a, b) =>
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
      const proceeds = sellQty * price - fees;
      const basis = sellQty * (s.avg || 0);
      const realized = proceeds - basis;

      s.qty -= sellQty;
      s.cost -= basis;
      s.realized += realized;
      s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    }
  }

  const goldSpot = safeNum(spot.GOLD, 0);
  const silverSpot = safeNum(spot.SILVER, 0);

  const goldMV = state.GOLD.qty * goldSpot;
  const silverMV = state.SILVER.qty * silverSpot;

  const goldUnr = (goldSpot - state.GOLD.avg) * state.GOLD.qty;
  const silverUnr = (silverSpot - state.SILVER.avg) * state.SILVER.qty;

  return {
    holdingValue: round2(goldMV + silverMV),
    unrealized: round2(goldUnr + silverUnr),
    realized: round2(state.GOLD.realized + state.SILVER.realized),
  };
}

function computeStocks(transactions, quoteMap) {
  const bySymbol = {};

  const txs = [...transactions].sort((a, b) =>
    String(a.date || "").localeCompare(String(b.date || ""))
  );

  for (const t of txs) {
    const symbol = String(t.symbol || "").toUpperCase();
    if (!symbol) continue;

    const type = String(t.type || "BUY").toUpperCase();
    const shares = safeNum(t.shares, 0);
    const price = safeNum(t.price, 0);
    const fees = safeNum(t.fees, 0);

    if (!bySymbol[symbol]) bySymbol[symbol] = { shares: 0, cost: 0, avg: 0, realized: 0 };

    const s = bySymbol[symbol];

    if (type === "BUY") {
      const addCost = shares * price + fees;
      s.shares += shares;
      s.cost += addCost;
      s.avg = s.shares > 0 ? s.cost / s.shares : 0;
    } else if (type === "SELL") {
      const sellShares = Math.min(shares, s.shares);
      const proceeds = sellShares * price - fees;
      const basis = sellShares * (s.avg || 0);
      const realized = proceeds - basis;

      s.shares -= sellShares;
      s.cost -= basis;
      s.realized += realized;
      s.avg = s.shares > 0 ? s.cost / s.shares : 0;
    }
  }

  let holdingValue = 0;
  let unrealized = 0;
  let realized = 0;

  for (const [sym, s] of Object.entries(bySymbol)) {
    const spot = safeNum(quoteMap[sym]?.price, 0);
    holdingValue += s.shares * spot;
    unrealized += (spot - s.avg) * s.shares;
    realized += s.realized;
  }

  return {
    holdingValue: round2(holdingValue),
    unrealized: round2(unrealized),
    realized: round2(realized),
  };
}

function computeFixedIncome(items) {
  // Holding Value: sum currentValue
  // Unrealized: sum (currentValue - principal)
  // Realized: 0 for now (until you add a "closed/matured" concept)
  let holdingValue = 0;
  let unrealized = 0;

  for (const it of items) {
    const cv = safeNum(it.currentValue, 0);
    const principal = safeNum(it.principal, 0);
    holdingValue += cv;
    unrealized += (cv - principal);
  }

  return {
    holdingValue: round2(holdingValue),
    unrealized: round2(unrealized),
    realized: 0,
  };
}

/* ---------------- Component ---------------- */

export default function Portfolio() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [fixedIncome, setFixedIncome] = useState([]);
  const [bullionTx, setBullionTx] = useState([]);
  const [stockTx, setStockTx] = useState([]);

  const [spot, setSpot] = useState({ GOLD: 0, SILVER: 0 });
  const [quotes, setQuotes] = useState({}); // { AAPL: { price, ... } }

  const [status, setStatus] = useState("");

  const stockSymbols = useMemo(() => {
    const set = new Set(stockTx.map((t) => String(t.symbol || "").toUpperCase()).filter(Boolean));
    return Array.from(set).sort();
  }, [stockTx]);

  const totals = useMemo(() => {
    const fi = computeFixedIncome(fixedIncome);
    const b = computeBullion(bullionTx, spot);
    const s = computeStocks(stockTx, quotes);

    const holdingValue = round2(fi.holdingValue + b.holdingValue + s.holdingValue);
    const unrealized = round2(fi.unrealized + b.unrealized + s.unrealized);
    const realized = round2(fi.realized + b.realized + s.realized);

    return { holdingValue, unrealized, realized };
  }, [fixedIncome, bullionTx, stockTx, spot, quotes]);

  async function refreshAll() {
    setLoading(true);
    setError("");
    setStatus("");

    try {
      // 1) Load all holdings/tx in parallel
      const [fiRes, bullRes, stockRes] = await Promise.all([
        apiFetch("/assets/fixedincome"),
        apiFetch("/assets/bullion/transactions"),
        apiFetch("/assets/stocks/transactions"),
      ]);

      const fiItems = Array.isArray(fiRes) ? fiRes : Array.isArray(fiRes?.items) ? fiRes.items : [];
      const bullItems = Array.isArray(bullRes) ? bullRes : Array.isArray(bullRes?.items) ? bullRes.items : [];
      const stockItems = Array.isArray(stockRes) ? stockRes : Array.isArray(stockRes?.items) ? stockRes.items : [];

      setFixedIncome(fiItems);
      setBullionTx(bullItems);
      setStockTx(stockItems);

      // 2) Prices (metals + crypto + optionally stocks via query)
      const symbols = Array.from(new Set(stockItems.map((t) => String(t.symbol || "").toUpperCase()).filter(Boolean))).sort();
      const qs = symbols.length ? `?stocks=${encodeURIComponent(symbols.join(","))}` : "";
      const pricesRes = await apiFetch(`/prices${qs}`);

      const goldPrice = safeNum(pricesRes?.gold?.price, 0);
      const silverPrice = safeNum(pricesRes?.silver?.price, 0);
      setSpot({ GOLD: round2(goldPrice), SILVER: round2(silverPrice) });

      if (symbols.length) {
        setQuotes(pricesRes?.stocks || {});
      } else {
        setQuotes({});
      }

      // Status message if any stock quote errors
      const stockErrors = pricesRes?.errors?.stocks;
      if (stockErrors && typeof stockErrors === "object") {
        const bad = Object.keys(stockErrors);
        setStatus(
          bad.length
            ? `Updated. Some stock quotes failed: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? "…" : ""}`
            : "Updated."
        );
      } else {
        setStatus("Updated.");
      }
    } catch (e) {
      setError(e?.message || "Failed to load portfolio data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!alive) return;
      await refreshAll();
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const asOfDate = todayISO();

  return (
    <div style={{ padding: 16, color: THEME.pageText }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 900, color: THEME.title, letterSpacing: "0.2px" }}>
            Portfolio
          </div>
          <div style={{ marginTop: 6, fontSize: 13, color: THEME.muted }}>
            Aggregated view across Fixed Income, Stocks, and Bullion.
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ fontSize: 12, color: THEME.muted, textAlign: "right" }}>
            As of <span style={{ color: THEME.pageText, fontWeight: 700 }}>{asOfDate}</span>
          </div>
          <button type="button" onClick={refreshAll} style={btnSecondary} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {error ? (
        <div style={{ marginTop: 12, ...callout }}>
          <div style={{ fontWeight: 900, color: THEME.title }}>Error</div>
          <div style={{ marginTop: 4, color: THEME.pageText }}>{error}</div>
        </div>
      ) : status ? (
        <div style={{ marginTop: 12, fontSize: 12, color: THEME.muted }}>{status}</div>
      ) : null}

      {/* Summary cards */}
      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(3, minmax(200px, 1fr))", gap: 12 }}>
        <SummaryCard title="Total Holding Value" value={formatMoney(totals.holdingValue)} hint="FixedIncome + Stocks + Bullion" />
        <SummaryCard title="Unrealized Gain/Loss" value={formatMoney(totals.unrealized)} hint="Includes FI accrual + mark-to-market" />
        <SummaryCard title="Realized Gain/Loss" value={formatMoney(totals.realized)} hint="From sell transactions (Stocks/Bullion)" />
      </div>

      {/* Optional: small counts line (keeps page from feeling empty) */}
      <div style={{ ...panel, marginTop: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 900, color: THEME.title }}>Included Assets</div>
        <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(3, minmax(160px, 1fr))", gap: 10 }}>
          <MiniStat label="Fixed Income Positions" value={String(fixedIncome.length)} />
          <MiniStat label="Stock Transactions" value={String(stockTx.length)} />
          <MiniStat label="Bullion Transactions" value={String(bullionTx.length)} />
        </div>

        {stockSymbols.length ? (
          <div style={{ marginTop: 10, fontSize: 12, color: THEME.muted }}>
            Stock symbols priced: <span style={{ color: THEME.pageText, fontWeight: 800 }}>{stockSymbols.join(", ")}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------- UI helpers ---------------- */

function SummaryCard({ title, value, hint }) {
  return (
    <div style={panel}>
      <div style={{ fontSize: 12, color: THEME.muted, fontWeight: 800 }}>{title}</div>
      <div style={{ marginTop: 6, fontSize: 20, fontWeight: 900, color: THEME.title }}>{value}</div>
      {hint ? <div style={{ marginTop: 6, fontSize: 12, color: THEME.muted }}>{hint}</div> : null}
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div style={{ border: `1px solid ${THEME.rowBorder}`, borderRadius: 12, padding: 12, background: "rgba(2, 6, 23, 0.25)" }}>
      <div style={{ fontSize: 12, color: THEME.muted, fontWeight: 800 }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 16, fontWeight: 900, color: THEME.title }}>{value}</div>
    </div>
  );
}

/* ---------------- styles ---------------- */

const panel = {
  background: THEME.panelBg,
  border: `1px solid ${THEME.panelBorder}`,
  borderRadius: 14,
  padding: 14,
  backdropFilter: "blur(6px)",
};

const btnSecondary = {
  padding: "10px 12px",
  borderRadius: 12,
  border: `1px solid ${THEME.panelBorder}`,
  background: "rgba(148, 163, 184, 0.06)",
  color: THEME.pageText,
  fontWeight: 900,
  cursor: "pointer",
};

const callout = {
  padding: 12,
  borderRadius: 12,
  background: "rgba(239, 68, 68, 0.10)",
  border: `1px solid ${THEME.dangerBorder}`,
};
