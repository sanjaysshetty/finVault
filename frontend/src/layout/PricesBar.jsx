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
  return list.find((x) => x?.symbol === symbol) || null;
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
    null;

  const ask =
    row.ask_price ??
    row.best_ask_price ??
    row.ask ??
    row.best_ask ??
    row.askPrice ??
    row.bestAsk ??
    null;

  return { bid, ask };
}

function midFromBidAsk(bid, ask) {
  const b = typeof bid === "string" ? Number(bid) : bid;
  const a = typeof ask === "string" ? Number(ask) : ask;
  if (!Number.isFinite(b) || !Number.isFinite(a)) return null;
  return (b + a) / 2;
}

function numberOrNull(x) {
  const n = typeof x === "string" ? Number(x) : x;
  return Number.isFinite(n) ? n : null;
}

function priceColor(price, prevClose) {
  const p = numberOrNull(price);
  const pc = numberOrNull(prevClose);
  if (p === null || pc === null) return "#E5E7EB"; // neutral
  if (p > pc) return "#22C55E"; // green
  if (p < pc) return "#EF4444"; // red
  return "#E5E7EB"; // unchanged
}

function MiniCard({ label, value, accent }) {
  return (
    <div
      style={{
        minWidth: 140,
        height: 46,
        borderRadius: 12,
        padding: "8px 10px",
        background: "rgba(2, 6, 23, 0.35)",
        border: "1px solid rgba(255,255,255,0.10)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        backdropFilter: "blur(6px)",
      }}
    >
      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.65)", fontWeight: 700 }}>
        {label}
      </div>

      <div
        className="numeric"
        style={{
          marginTop: 3,
          fontSize: 14,
          fontWeight: 900,
          color: accent,
          lineHeight: 1,
        }}
      >
        {value}
      </div>
    </div>
  );
}

export default function PricesBar() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const apiUrl = useMemo(() => `${API_BASE}/prices`, []);

  async function load() {
    setLoading(true);
    try {
      const resp = await authedFetch(apiUrl);
      if (!resp.ok) throw new Error(`API ${resp.status}`);
      setData(await resp.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const gold = data?.gold;
  const silver = data?.silver;

  const btcRow = findBySymbol(data?.crypto, "BTC-USD");
  const ethRow = findBySymbol(data?.crypto, "ETH-USD");

  const btc = pickBidAsk(btcRow);
  const eth = pickBidAsk(ethRow);

  const btcMid = midFromBidAsk(btc.bid, btc.ask);
  const ethMid = midFromBidAsk(eth.bid, eth.ask);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <MiniCard label="Portfolio" value="—" accent="#FFFFFF" />

      <MiniCard
        label="Gold"
        value={loading ? "…" : fmtUSD(numberOrNull(gold?.price))}
        accent={priceColor(gold?.price, gold?.prev_close_price)}
      />

      <MiniCard
        label="Silver"
        value={loading ? "…" : fmtUSD(numberOrNull(silver?.price))}
        accent={priceColor(silver?.price, silver?.prev_close_price)}
      />

      <MiniCard label="BTC" value={loading ? "…" : fmtMaybeNumberUSD(btcMid)} accent="#F59E0B" />
      <MiniCard label="ETH" value={loading ? "…" : fmtMaybeNumberUSD(ethMid)} accent="#F59E0B" />

      <button
        onClick={load}
        style={{
          height: 46,
          padding: "0 12px",
          borderRadius: 12,
          border: "1px solid rgba(255,255,255,0.14)",
          background: "rgba(2, 6, 23, 0.35)",
          color: "#FFFFFF",
          fontWeight: 900,
          cursor: "pointer",
          backdropFilter: "blur(6px)",
        }}
      >
        Refresh
      </button>
    </div>
  );
}
