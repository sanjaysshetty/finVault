import { useEffect, useMemo, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE;

/* -------------------- Formatting -------------------- */
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

/* -------------------- Direction logic (metals only) -------------------- */
function priceDirection(price, prevClose) {
  if (typeof price !== "number" || typeof prevClose !== "number") {
    return "neutral";
  }
  return price >= prevClose ? "up" : "down";
}

/* -------------------- Small row -------------------- */
function Row({ label, value }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        fontSize: 13,
        color: "#9CA3AF",
        marginTop: 6,
      }}
    >
      <span>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", color: "#E5E7EB" }}>
        {value}
      </span>
    </div>
  );
}

/* -------------------- Card -------------------- */
function Card({ title, pair, price, bid, ask, accent, direction = "neutral" }) {
  const colorMap = {
    up: "#16A34A",     // muted green
    down: "#DC2626",   // muted red
    neutral: accent,
  };

  const highlight = colorMap[direction] || accent;

  return (
    <div
      style={{
        borderRadius: 12,
        padding: 14,
        background: "#0F172A",
        border: `1px solid ${highlight}33`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{title}</div>
          <div
            style={{
              fontSize: 11,
              color: "#9CA3AF",
              marginTop: 4,
              letterSpacing: "0.02em",
            }}
          >
            {pair}
          </div>
        </div>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: highlight,
            marginTop: 6,
          }}
        />
      </div>

      <div
        style={{
          marginTop: 12,
          fontSize: 22,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          color: highlight,
        }}
      >
        {price}
      </div>

      <div style={{ marginTop: 14 }}>
        <Row label="Bid" value={bid} />
        <Row label="Ask" value={ask} />
      </div>
    </div>
  );
}

/* -------------------- Crypto helpers -------------------- */
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

/* -------------------- App -------------------- */
export default function Prices() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const apiUrl = useMemo(() => `${API_BASE}/prices`, []);

  async function load() {
    setLoading(true);
    setErr("");
    try {
      const resp = await fetch(apiUrl, { cache: "no-store" });
      if (!resp.ok) throw new Error(`API ${resp.status}`);
      setData(await resp.json());
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const gold = data?.gold;
  const silver = data?.silver;

  const goldDir = priceDirection(gold?.price, gold?.prev_close_price);
  const silverDir = priceDirection(silver?.price, silver?.prev_close_price);

  const btcRow = findBySymbol(data?.crypto, "BTC-USD");
  const ethRow = findBySymbol(data?.crypto, "ETH-USD");

  const btc = pickBidAsk(btcRow);
  const eth = pickBidAsk(ethRow);

  const btcMid = midFromBidAsk(btc.bid, btc.ask);
  const ethMid = midFromBidAsk(eth.bid, eth.ask);

  // 🔑 Single amber color for ALL crypto prices
  const CRYPTO_AMBER = "#F59E0B";

  return (
    <div
      style={{
        minHeight: "100dvh",
        width: "100vw",
        background: "#020617",
        color: "#F9FAFB",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Inter, sans-serif",
      }}
    >
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 16px" }}>
        {/* Header */}
        <div
          style={{
            marginBottom: 20,
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              Metals & Crypto Prices
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: "#9CA3AF" }}>
              Spot prices · USD
            </div>
          </div>

          <button
            onClick={load}
            style={{
              padding: "10px 14px",
              borderRadius: 12,
              border: "1px solid #1F2937",
              background: "#0F172A",
              color: "#F9FAFB",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Refresh
          </button>
        </div>

        {/* States */}
        {loading && (
          <div style={{ color: "#9CA3AF", fontSize: 14 }}>
            Loading prices…
          </div>
        )}

        {err && (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 10,
              background: "#111827",
              border: "1px solid #374151",
              color: "#FCA5A5",
              fontSize: 13,
            }}
          >
            Failed to load prices — {err}
          </div>
        )}

        {/* Cards */}
        {!loading && !err && (
          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            }}
          >
            <Card
              title="Gold"
              pair="XAU / USD"
              price={fmtUSD(gold?.price)}
              bid={fmtUSD(gold?.bid)}
              ask={fmtUSD(gold?.ask)}
              accent="#FACC15"
              direction={goldDir}
            />

            <Card
              title="Silver"
              pair="XAG / USD"
              price={fmtUSD(silver?.price)}
              bid={fmtUSD(silver?.bid)}
              ask={fmtUSD(silver?.ask)}
              accent="#9CA3AF"
              direction={silverDir}
            />

            <Card
              title="Bitcoin"
              pair="BTC / USD"
              price={fmtMaybeNumberUSD(btcMid)}
              bid={fmtMaybeNumberUSD(btc.bid)}
              ask={fmtMaybeNumberUSD(btc.ask)}
              accent={CRYPTO_AMBER}
              direction="neutral"
            />

            <Card
              title="Ether"
              pair="ETH / USD"
              price={fmtMaybeNumberUSD(ethMid)}
              bid={fmtMaybeNumberUSD(eth.bid)}
              ask={fmtMaybeNumberUSD(eth.ask)}
              accent={CRYPTO_AMBER}
              direction="neutral"
            />
          </div>
        )}

        {/* Footer */}
        <div style={{ marginTop: 24, fontSize: 12, color: "#6B7280" }}>
          Updated{" "}
          {data?.fetchedAt
            ? new Date(data.fetchedAt).toLocaleTimeString()
            : "—"}
        </div>
      </div>
    </div>
  );
}
