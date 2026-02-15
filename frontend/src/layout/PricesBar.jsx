import { useEffect, useMemo, useState } from "react";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_BASE || "").replace(
  /\/+$/,
  ""
);

function getAuthToken() {
  return (
    sessionStorage.getItem("finvault.accessToken") ||
    sessionStorage.getItem("finvault.idToken") ||
    ""
  );
}

async function authedFetch(url, options = {}) {
  const token = getAuthToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { ...options, headers, cache: "no-store" });
}

function fmtUSD(x) {
  if (typeof x !== "number") return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(x);
}

function fmtMaybeNumberUSD(x) {
  if (x === null || x === undefined) return "—";
  const n = typeof x === "string" ? Number(x) : x;
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtNumber(x) {
  if (typeof x !== "number") return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(x);
}

function numberOrNull(x) {
  const n = typeof x === "string" ? Number(x) : x;
  return Number.isFinite(n) ? n : null;
}

function fmtPctFromPrevClose(price, prevClose) {
  const p = numberOrNull(price);
  const pc = numberOrNull(prevClose);
  if (p === null || pc === null || pc === 0) return "";
  const pct = ((p - pc) / pc) * 100;
  if (!Number.isFinite(pct)) return "";
  const sign = pct > 0 ? "+" : "";
  return ` (${sign}${pct.toFixed(2)}%)`;
}

/* ---------------- Crypto parsing ---------------- */

function extractList(payload) {
  if (!payload) return null;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.best_bid_asks)) return payload.best_bid_asks;
  if (Array.isArray(payload.items)) return payload.items;
  return null;
}

function findBySymbol(payload, symbol) {
  const list = extractList(payload);
  if (!list) return null;
  return list.find((x) => String(x?.symbol || "").toUpperCase() === symbol) || null;
}

function pickBidAsk(row) {
  if (!row) return { bid: null, ask: null };

  const bid =
    row.bid_price ??
    row.best_bid_price ??
    row.bid ??
    row.best_bid ??
    row.bidPrice ??
    row.bestBid ??
    row.bid_inclusive_of_sell_spread ??
    null;

  const ask =
    row.ask_price ??
    row.best_ask_price ??
    row.ask ??
    row.best_ask ??
    row.askPrice ??
    row.bestAsk ??
    row.ask_inclusive_of_buy_spread ??
    null;

  return { bid, ask };
}

function midFromBidAsk(bid, ask) {
  const b = typeof bid === "string" ? Number(bid) : bid;
  const a = typeof ask === "string" ? Number(ask) : ask;
  if (!Number.isFinite(b) || !Number.isFinite(a)) return null;
  return (b + a) / 2;
}

function priceColor(price, prevClose) {
  const p = numberOrNull(price);
  const pc = numberOrNull(prevClose);
  if (p === null || pc === null) return "#E5E7EB";
  if (p > pc) return "#22C55E";
  if (p < pc) return "#EF4444";
  return "#E5E7EB";
}

/* ---------------- UI ---------------- */

function MiniCard({ label, value, accent, title }) {
  return (
    <div
      style={{
        // tighter so the bar fits when values get longer
        minWidth: 126,
        height: 44,
        borderRadius: 12,
        padding: "7px 10px",
        background: "rgba(2, 6, 23, 0.35)",
        border: "1px solid rgba(255,255,255,0.10)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        backdropFilter: "blur(6px)",
        flex: "0 0 auto", // critical: do NOT stretch and do NOT force wrap
      }}
      title={title || value}
    >
      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.65)", fontWeight: 800, lineHeight: 1 }}>
        {label}
      </div>

      <div
        className="numeric"
        style={{
          marginTop: 3,
          fontSize: 13,
          fontWeight: 900,
          color: accent,
          lineHeight: 1.05,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {value}
      </div>
    </div>
  );
}

/* ---------------- Portfolio value helpers ---------------- */

function safeNum(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

// ✅ NEW: filter helper (exclude Property)
function isPropertyOtherAsset(it) {
  const cat = String(it?.category || "").trim().toUpperCase();
  const catKey = String(it?.categoryKey || "").trim().toUpperCase();
  return cat === "PROPERTY" || catKey === "PROPERTY";
}

function computeFixedIncomeHolding(items) {
  let holding = 0;
  for (const it of items || []) holding += safeNum(it.currentValue, 0);
  return holding;
}

function computeBullionHolding(transactions, spot) {
  const state = { GOLD: { qty: 0 }, SILVER: { qty: 0 } };
  const txs = [...(transactions || [])].sort((a, b) =>
    String(a.date || "").localeCompare(String(b.date || ""))
  );

  for (const t of txs) {
    const metal = String(t.metal || "").toUpperCase();
    const type = String(t.type || "").toUpperCase();
    if (!state[metal]) continue;

    const qty = safeNum(t.quantityOz, 0);
    if (type === "BUY") state[metal].qty += qty;
    else if (type === "SELL") state[metal].qty -= Math.min(qty, state[metal].qty);
  }

  return state.GOLD.qty * safeNum(spot?.GOLD, 0) + state.SILVER.qty * safeNum(spot?.SILVER, 0);
}

function computeStocksHolding(transactions, quoteMap) {
  const bySymbol = {};
  const txs = [...(transactions || [])].sort((a, b) =>
    String(a.date || "").localeCompare(String(b.date || ""))
  );

  for (const t of txs) {
    const sym = String(t.symbol || "").toUpperCase().trim();
    if (!sym) continue;
    const type = String(t.type || "BUY").toUpperCase();
    const shares = safeNum(t.shares, 0);

    if (!bySymbol[sym]) bySymbol[sym] = 0;
    if (type === "BUY") bySymbol[sym] += shares;
    else if (type === "SELL") bySymbol[sym] -= Math.min(shares, bySymbol[sym]);
  }

  let holding = 0;
  for (const [sym, shares] of Object.entries(bySymbol)) {
    holding += shares * safeNum(quoteMap?.[sym]?.price, 0);
  }
  return holding;
}

function extractCryptoSpotsFromPrices(pricesRes) {
  const crypto = pricesRes?.crypto;
  const list = extractList(crypto);
  const out = {};

  const readOne = (row) => {
    const sym = String(row?.symbol || row?.pair || "").toUpperCase().trim();
    if (!sym) return;

    const { bid, ask } = pickBidAsk(row);
    const mid = midFromBidAsk(bid, ask);
    const spot = Number.isFinite(mid) ? mid : safeNum(row?.price, 0);
    if (spot > 0) out[sym] = spot;
  };

  if (Array.isArray(list)) list.forEach(readOne);
  return out;
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

    if (!bySym[sym]) bySym[sym] = 0;
    if (type === "BUY") bySym[sym] += qty;
    else if (type === "SELL") bySym[sym] -= Math.min(qty, bySym[sym]);
  }

  let holding = 0;
  for (const [sym, qty] of Object.entries(bySym)) {
    holding += qty * safeNum(spotMap?.[sym], 0);
  }
  return holding;
}

function computeOtherAssetsHolding(items) {
  let holding = 0;
  for (const it of items || []) {
    // ✅ Exclude Property-category items from portfolio value calc
    if (isPropertyOtherAsset(it)) continue;
    holding += safeNum(it?.value ?? it?.assetValue, 0);
  }
  return holding;
}

/* ---------------- Index helpers ---------------- */

function indexPrice(idx) {
  return numberOrNull(idx?.price ?? idx?.regularMarketPrice ?? idx?.last ?? idx?.close ?? idx?.c ?? null);
}

function indexPrevClose(idx) {
  return numberOrNull(
    idx?.prevClose ??
      idx?.previousClose ??
      idx?.chartPreviousClose ??
      idx?.prev_close ??
      idx?.pc ??
      idx?.regularMarketPreviousClose ??
      null
  );
}

/* ---------------- Component ---------------- */

export default function PricesBar() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const [portfolioValue, setPortfolioValue] = useState(null);
  const [portfolioLoading, setPortfolioLoading] = useState(true);

  // NOTE: we do NOT memoize with [] if API_BASE can change between builds,
  // but keeping your original approach.
  const basePricesUrl = useMemo(() => `${API_BASE}/prices`, []);

  function extractItems(res) {
    return Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
  }

  function buildSymbolsFromTx(stockTx, cryptoTx) {
    const stockSet = new Set();
    for (const t of stockTx || []) {
      const s = String(t.symbol || "").toUpperCase().trim();
      if (s) stockSet.add(s);
    }

    const cryptoSet = new Set();
    for (const t of cryptoTx || []) {
      let s = String(t.symbol || "").toUpperCase().trim();
      if (!s) continue;
      if (!s.includes("-")) s = `${s}-USD`;
      cryptoSet.add(s);
    }

    // caps (keep URLs sane)
    const stocks = Array.from(stockSet).slice(0, 25);
    const crypto = Array.from(cryptoSet).slice(0, 25);

    return { stocks, crypto };
  }

  function buildPricesUrl(stocks, crypto) {
    const params = new URLSearchParams();
    if (stocks?.length) params.set("stocks", stocks.join(","));
    if (crypto?.length) params.set("crypto", crypto.join(","));
    const qs = params.toString();
    return qs ? `${basePricesUrl}?${qs}` : basePricesUrl;
  }

  async function loadAll() {
    setLoading(true);
    setPortfolioLoading(true);

    try {
      // 1) Load asset data first so /prices can include the right quotes (matches Portfolio.jsx behavior)
      const [fiResp, bullResp, stockResp, cryptoResp, otherResp] = await Promise.all([
        authedFetch(`${API_BASE}/assets/fixedincome`),
        authedFetch(`${API_BASE}/assets/bullion/transactions`),
        authedFetch(`${API_BASE}/assets/stocks/transactions`),
        authedFetch(`${API_BASE}/assets/crypto/transactions`),
        authedFetch(`${API_BASE}/assets/otherassets`),
      ]);

      if (!fiResp.ok) throw new Error(`FixedIncome API ${fiResp.status}`);
      if (!bullResp.ok) throw new Error(`Bullion API ${bullResp.status}`);
      if (!stockResp.ok) throw new Error(`Stocks API ${stockResp.status}`);
      if (!cryptoResp.ok) throw new Error(`Crypto API ${cryptoResp.status}`);
      if (!otherResp.ok) throw new Error(`OtherAssets API ${otherResp.status}`);

      const fiRes = await fiResp.json();
      const bullRes = await bullResp.json();
      const stockRes = await stockResp.json();
      const cryptoRes = await cryptoResp.json();
      const otherRes = await otherResp.json();

      const fixedIncome = extractItems(fiRes);
      const bullionTx = extractItems(bullRes);
      const stockTx = extractItems(stockRes);
      const cryptoTx = extractItems(cryptoRes);
      const otherAssets = extractItems(otherRes);

      const { stocks: stockSyms, crypto: cryptoSyms } = buildSymbolsFromTx(stockTx, cryptoTx);

      // 2) Load /prices with those symbols so we can compute market value the same way Portfolio.jsx does
      const pricesUrl = buildPricesUrl(stockSyms, cryptoSyms);
      const pricesResp = await authedFetch(pricesUrl);
      if (!pricesResp.ok) throw new Error(`Prices API ${pricesResp.status}`);
      const pricesRes = await pricesResp.json();
      setData(pricesRes);

      // 3) Compute portfolio total holding value (market value across FI + Bullion + Stocks + Crypto + Other Assets)
      const spot = {
        GOLD: safeNum(pricesRes?.gold?.price, 0),
        SILVER: safeNum(pricesRes?.silver?.price, 0),
      };

      const stockQuotes = pricesRes?.stocks || {};
      const cryptoSpots = extractCryptoSpotsFromPrices(pricesRes);

      const total =
        computeFixedIncomeHolding(fixedIncome) +
        computeBullionHolding(bullionTx, spot) +
        computeStocksHolding(stockTx, stockQuotes) +
        computeCryptoHolding(cryptoTx, cryptoSpots) +
        // ✅ excludes Property
        computeOtherAssetsHolding(otherAssets);

      setPortfolioValue(Number.isFinite(total) ? total : null);
    } catch {
      setData(null);
      setPortfolioValue(null);
    } finally {
      setLoading(false);
      setPortfolioLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pull everything from /prices response
  const spxRaw = data?.sp500;
  const ixicRaw = data?.nasdaq;

  const spxP = indexPrice(spxRaw);
  const spxPC = indexPrevClose(spxRaw);

  const ixicP = indexPrice(ixicRaw);
  const ixicPC = indexPrevClose(ixicRaw);

  const gold = data?.gold;
  const silver = data?.silver;

  const btcRow = findBySymbol(data?.crypto, "BTC-USD");
  const ethRow = findBySymbol(data?.crypto, "ETH-USD");

  const btc = pickBidAsk(btcRow);
  const eth = pickBidAsk(ethRow);

  const btcMid = midFromBidAsk(btc.bid, btc.ask);
  const ethMid = midFromBidAsk(eth.bid, eth.ask);

  const spxValue =
    loading ? "…" : spxP != null ? `${fmtNumber(spxP)}${fmtPctFromPrevClose(spxP, spxPC)}` : "—";

  const ixicValue =
    loading ? "…" : ixicP != null ? `${fmtNumber(ixicP)}${fmtPctFromPrevClose(ixicP, ixicPC)}` : "—";

  const goldValue =
    loading
      ? "…"
      : gold?.price != null
      ? `${fmtUSD(numberOrNull(gold.price))}${fmtPctFromPrevClose(gold.price, gold.prev_close_price)}`
      : "—";

  const silverValue =
    loading
      ? "…"
      : silver?.price != null
      ? `${fmtUSD(numberOrNull(silver.price))}${fmtPctFromPrevClose(silver.price, silver.prev_close_price)}`
      : "—";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "nowrap", // critical: never wrap into 2 lines
        overflowX: "auto", // critical: allow scroll instead of overlap
        overflowY: "hidden",
        maxWidth: "100%",
        minWidth: 0, // critical: allow shrink inside parent flex
        paddingBottom: 2,
        WebkitOverflowScrolling: "touch",
      }}
    >
      {/* Sequence: Portfolio, S&P 500, Nasdaq, Gold, Silver, BTC, ETH */}
      <MiniCard
        label="Portfolio"
        value={portfolioLoading ? "…" : fmtMaybeNumberUSD(portfolioValue)}
        accent="#FFFFFF"
        title="Total holding value (Fixed Income + Stocks + Crypto + Bullion + Other Assets; excluding Property in Other Assets)"
      />

      <MiniCard label="S&P 500" value={spxValue} accent={priceColor(spxP, spxPC)} />
      <MiniCard label="Nasdaq" value={ixicValue} accent={priceColor(ixicP, ixicPC)} />

      <MiniCard label="Gold" value={goldValue} accent={priceColor(gold?.price, gold?.prev_close_price)} />
      <MiniCard label="Silver" value={silverValue} accent={priceColor(silver?.price, silver?.prev_close_price)} />

      <MiniCard label="BTC" value={loading ? "…" : fmtMaybeNumberUSD(btcMid)} accent="#F59E0B" />
      <MiniCard label="ETH" value={loading ? "…" : fmtMaybeNumberUSD(ethMid)} accent="#F59E0B" />

      <button
        onClick={loadAll}
        style={{
          height: 44,
          padding: "0 10px",
          borderRadius: 12,
          border: "1px solid rgba(255,255,255,0.14)",
          background: "rgba(2, 6, 23, 0.35)",
          color: "#FFFFFF",
          fontWeight: 900,
          cursor: "pointer",
          backdropFilter: "blur(6px)",
          flex: "0 0 auto",
          whiteSpace: "nowrap",
        }}
        title="Refresh"
      >
        Refresh
      </button>
    </div>
  );
}
