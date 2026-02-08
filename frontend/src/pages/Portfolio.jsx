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

function plColor(v) {
  return safeNum(v, 0) < 0 ? "rgba(248,113,113,0.95)" : "rgba(134,239,172,0.95)";
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

/* ---------------- Crypto spot parsing (replicate Crypto.jsx behavior) ---------------- */
/**
 * Builds a spot map: { "BTC-USD": 43000.12, ... }
 * from /prices response (pricesRes.crypto).
 */
function extractCryptoSpots(pricesResponse) {
  const crypto = pricesResponse?.crypto;
  if (!crypto) return {};

  const arr =
    Array.isArray(crypto)
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

  const readOne = (obj) => {
    const sym = obj?.symbol || obj?.instrument_id || obj?.pair || "";
    if (!sym) return;

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
    arr.forEach(readOne);
    return out;
  }

  // keyed object fallback
  if (typeof crypto === "object") {
    Object.entries(crypto).forEach(([sym, obj]) => {
      if (!obj) return;
      readOne({ ...obj, symbol: sym });
    });
  }

  return out;
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
    const symbol = String(t.symbol || "").toUpperCase().trim();
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

function computeCrypto(transactions, spotMap) {
  const bySym = {};

  const txs = [...transactions].sort((a, b) =>
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

    if (!bySym[sym]) bySym[sym] = { qty: 0, cost: 0, avg: 0, realized: 0 };
    const s = bySym[sym];

    if (type === "BUY") {
      const addCost = qty * px + fees;
      s.qty += qty;
      s.cost += addCost;
      s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    } else if (type === "SELL") {
      const sellQty = Math.min(qty, s.qty);
      const proceeds = sellQty * px - fees;
      const basis = sellQty * (s.avg || 0);
      const realized = proceeds - basis;

      s.qty -= sellQty;
      s.cost -= basis;
      s.realized += realized;
      s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    }
  }

  let holdingValue = 0;
  let unrealized = 0;
  let realized = 0;

  for (const [sym, s] of Object.entries(bySym)) {
    const spot = safeNum(spotMap?.[sym], 0);
    holdingValue += s.qty * spot;
    unrealized += (spot - (s.avg || 0)) * s.qty;
    realized += s.realized;
  }

  return {
    holdingValue: round2(holdingValue),
    unrealized: round2(unrealized),
    realized: round2(realized),
  };
}

function computeFixedIncome(items) {
  let holdingValue = 0;
  let unrealized = 0;

  for (const it of items) {
    const cv = safeNum(it.currentValue, 0);
    const principal = safeNum(it.principal, 0);
    holdingValue += cv;
    unrealized += cv - principal;
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
  const [cryptoTx, setCryptoTx] = useState([]);

  const [spot, setSpot] = useState({ GOLD: 0, SILVER: 0 });
  const [quotes, setQuotes] = useState({}); // stocks: { AAPL: { price, ... } }
  const [cryptoSpots, setCryptoSpots] = useState({}); // crypto: { "BTC-USD": 43000.12 }

  const [status, setStatus] = useState("");

  const stockSymbols = useMemo(() => {
    const set = new Set(stockTx.map((t) => String(t.symbol || "").toUpperCase().trim()).filter(Boolean));
    return Array.from(set).sort();
  }, [stockTx]);

  const cryptoSymbols = useMemo(() => {
    const set = new Set(
      cryptoTx
        .map((t) => String(t.symbol || "").toUpperCase().trim())
        .filter(Boolean)
        .map((s) => (s.includes("-") ? s : `${s}-USD`))
    );
    return Array.from(set).sort();
  }, [cryptoTx]);

  // Per-asset rollups
  const rollups = useMemo(() => {
    const fixedIncomeRollup = computeFixedIncome(fixedIncome);
    const bullionRollup = computeBullion(bullionTx, spot);
    const stocksRollup = computeStocks(stockTx, quotes);
    const cryptoRollup = computeCrypto(cryptoTx, cryptoSpots);

    // Options placeholder only
    const optionsRollup = { holdingValue: 0, realized: 0, unrealized: 0 };

    return {
      stocks: stocksRollup,
      crypto: cryptoRollup,
      bullion: bullionRollup,
      fixedIncome: fixedIncomeRollup,
      options: optionsRollup,
    };
  }, [fixedIncome, bullionTx, stockTx, cryptoTx, spot, quotes, cryptoSpots]);

  // Totals (TOP SUMMARY) includes ALL assets incl crypto
  const totals = useMemo(() => {
    const holdingValue = round2(
      rollups.fixedIncome.holdingValue +
        rollups.bullion.holdingValue +
        rollups.stocks.holdingValue +
        rollups.crypto.holdingValue +
        rollups.options.holdingValue
    );

    const unrealized = round2(
      rollups.fixedIncome.unrealized +
        rollups.bullion.unrealized +
        rollups.stocks.unrealized +
        rollups.crypto.unrealized +
        rollups.options.unrealized
    );

    const realized = round2(
      rollups.fixedIncome.realized +
        rollups.bullion.realized +
        rollups.stocks.realized +
        rollups.crypto.realized +
        rollups.options.realized
    );

    return { holdingValue, unrealized, realized };
  }, [rollups]);

  async function refreshAll() {
    setLoading(true);
    setError("");
    setStatus("");

    try {
      // 1) Load holdings/tx
      const [fiRes, bullRes, stockRes, cryptoRes] = await Promise.all([
        apiFetch("/assets/fixedincome"),
        apiFetch("/assets/bullion/transactions"),
        apiFetch("/assets/stocks/transactions"),
        apiFetch("/assets/crypto/transactions"),
      ]);

      const fiItems = Array.isArray(fiRes) ? fiRes : Array.isArray(fiRes?.items) ? fiRes.items : [];
      const bullItems = Array.isArray(bullRes) ? bullRes : Array.isArray(bullRes?.items) ? bullRes.items : [];
      const stockItems = Array.isArray(stockRes) ? stockRes : Array.isArray(stockRes?.items) ? stockRes.items : [];
      const cryptoItems = Array.isArray(cryptoRes) ? cryptoRes : Array.isArray(cryptoRes?.items) ? cryptoRes.items : [];

      setFixedIncome(fiItems);
      setBullionTx(bullItems);
      setStockTx(stockItems);
      setCryptoTx(cryptoItems);

      // 2) Prices (metals + crypto + optional stocks)
      const symbols = Array.from(new Set(stockItems.map((t) => String(t.symbol || "").toUpperCase().trim()).filter(Boolean))).sort();
      const cryptoSyms = Array.from(
        new Set(
          cryptoItems
            .map((t) => String(t.symbol || "").toUpperCase().trim())
            .filter(Boolean)
            .map((s) => (s.includes("-") ? s : `${s}-USD`))
        )
      ).sort();

      const qsParts = [];
      if (symbols.length) qsParts.push(`stocks=${encodeURIComponent(symbols.join(","))}`);
      if (cryptoSyms.length) qsParts.push(`crypto=${encodeURIComponent(cryptoSyms.join(","))}`);
      const qs = qsParts.length ? `?${qsParts.join("&")}` : "";

      const pricesRes = await apiFetch(`/prices${qs}`);

      // Metals spots
      const goldPrice = safeNum(pricesRes?.gold?.price, 0);
      const silverPrice = safeNum(pricesRes?.silver?.price, 0);
      setSpot({ GOLD: round2(goldPrice), SILVER: round2(silverPrice) });

      // Stock quotes
      setQuotes(symbols.length ? (pricesRes?.stocks || {}) : {});

      // Crypto spots (same logic style as Crypto.jsx)
      const spotMap = extractCryptoSpots(pricesRes);
      setCryptoSpots(spotMap);

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
       // setStatus("Updated.");
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

  const includedRows = useMemo(
    () => [
      { key: "stocks", label: "Stocks", ...rollups.stocks, hint: stockSymbols.length ? `${stockSymbols.length} symbols` : "" },
      { key: "crypto", label: "Crypto", ...rollups.crypto, hint: cryptoSymbols.length ? `${cryptoSymbols.length} symbols` : "" },
      { key: "bullion", label: "Bullion", ...rollups.bullion, hint: bullionTx.length ? `${bullionTx.length} tx` : "" },
      { key: "fixedIncome", label: "Fixed Income", ...rollups.fixedIncome, hint: fixedIncome.length ? `${fixedIncome.length} positions` : "" },
      { key: "options", label: "Options", ...rollups.options, hint: "placeholder" },
    ],
    [rollups, stockSymbols.length, cryptoSymbols.length, bullionTx.length, fixedIncome.length]
  );

  return (
    <div style={{ padding: 16, color: THEME.pageText }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 900, color: THEME.title, letterSpacing: "0.2px" }}>
            Portfolio
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

      {/* Summary cards (includes Crypto unrealized) */}
      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(3, minmax(200px, 1fr))", gap: 12 }}>
        <SummaryCard title="Total Holding Value" value={formatMoney(totals.holdingValue)} hint="All asset types combined" />
        <SummaryCard title="Unrealized Gain/Loss" value={formatMoney(totals.unrealized)} hint="Includes FI accrual + mark-to-market (Stocks/Crypto/Bullion)"  valueColor={plColor(totals.unrealized)} />
        <SummaryCard title="Realized Gain/Loss" value={formatMoney(totals.realized)} hint="From sells (Stocks/Crypto/Bullion)"  valueColor={plColor(totals.realized)} />
      </div>

      {/* Included Assets table */}
      <div style={{ ...panel, marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 900, color: THEME.title }}>Included Assets</div>
            <div style={{ marginTop: 6, fontSize: 12, color: THEME.muted }}>
              Rollup by asset type (Latest Value / Realized / Unrealized).
            </div>
          </div>

          <div style={{ fontSize: 12, color: THEME.muted }}>
            Updated <span style={{ color: THEME.pageText, fontWeight: 800 }}>{asOfDate}</span>
          </div>
        </div>

        <div style={{ marginTop: 12, borderTop: `1px solid ${THEME.rowBorder}` }} />

        <div style={{ marginTop: 10, overflowX: "auto" }}>
          <div style={{ minWidth: 720 }}>
            {/* Header */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "220px 1fr 1fr 1fr",
                gap: 10,
                padding: "10px 0",
                color: THEME.muted,
                fontSize: 11,
                fontWeight: 900,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              <div>Asset Type</div>
              <div style={{ textAlign: "right" }}>Latest Value</div>
              <div style={{ textAlign: "right" }}>Realized</div>
              <div style={{ textAlign: "right" }}>Unrealized</div>
            </div>

            <div style={{ borderTop: `1px solid ${THEME.rowBorder}` }} />

            {/* Rows */}
            {includedRows.map((r) => {
              const realizedNeg = safeNum(r.realized, 0) < 0;
              const unrealizedNeg = safeNum(r.unrealized, 0) < 0;

              return (
                <div
                  key={r.key}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "220px 1fr 1fr 1fr",
                    gap: 10,
                    padding: "12px 0",
                    borderBottom: `1px solid ${THEME.rowBorder}`,
                    alignItems: "center",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 900, color: THEME.title }}>{r.label}</div>
                    {r.hint ? (
                      <div style={{ marginTop: 4, fontSize: 12, color: THEME.muted }}>
                        {r.hint}
                      </div>
                    ) : null}
                  </div>

                  <div style={{ textAlign: "right", fontWeight: 900, color: THEME.title }}>
                    {formatMoney(r.holdingValue)}
                  </div>

                  <div
                    style={{
                      textAlign: "right",
                      fontWeight: 900,
                      color: realizedNeg ? "rgba(248,113,113,0.95)" : "rgba(134,239,172,0.95)",
                    }}
                  >
                    {formatMoney(r.realized)}
                  </div>

                  <div
                    style={{
                      textAlign: "right",
                      fontWeight: 900,
                      color: unrealizedNeg ? "rgba(248,113,113,0.95)" : "rgba(134,239,172,0.95)",
                    }}
                  >
                    {formatMoney(r.unrealized)}
                  </div>
                </div>
              );
            })}

            {/* Totals row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "220px 1fr 1fr 1fr",
                gap: 10,
                padding: "12px 0",
                alignItems: "center",
              }}
            >
              <div style={{ fontWeight: 900, color: THEME.pageText }}>Total</div>
              <div style={{ textAlign: "right", fontWeight: 900, color: THEME.title }}>
                {formatMoney(totals.holdingValue)}
              </div>
              <div style={{ textAlign: "right", fontWeight: 900, color: THEME.title }}>
                {formatMoney(totals.realized)}
              </div>
              <div style={{ textAlign: "right", fontWeight: 900, color: THEME.title }}>
                {formatMoney(totals.unrealized)}
              </div>
            </div>

            {/* Optional: quick hint if crypto spots are missing */}
            {cryptoSymbols.length && Object.keys(cryptoSpots || {}).length === 0 ? (
              <div style={{ marginTop: 10, fontSize: 12, color: THEME.muted }}>
                Note: Crypto prices not returned from /prices right now, so crypto market value will show as $0.00.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- UI helpers ---------------- */

function SummaryCard({ title, value, hint, valueColor }) {
  return (
    <div style={panel}>
      <div style={{ fontSize: 12, color: THEME.muted, fontWeight: 800 }}>{title}</div>
      <div style={{ marginTop: 6, fontSize: 20, fontWeight: 900, color: valueColor || THEME.title }}>{value}</div>
      {hint ? <div style={{ marginTop: 6, fontSize: 12, color: THEME.muted }}>{hint}</div> : null}
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
