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

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

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
  // Mimic Portfolio.jsx gain/loss coloring
  return safeNum(v, 0) < 0 ? "rgba(248,113,113,0.95)" : "rgba(134,239,172,0.95)";
}


/* ---------------- API (same pattern as Bullion/FixedIncome) ---------------- */

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

/* ---------------- Domain ---------------- */

const DEFAULT_FORM = {
  type: "BUY",
  symbol: "AAPL",
  date: todayISO(),
  shares: "",
  price: "",
  fees: "",
  notes: "",
};

function normalizeTx(item) {
  return {
    ...item,
    id: item.txId || item.assetId || item.id,
    symbol: String(item.symbol || "").toUpperCase(),
    type: String(item.type || "BUY").toUpperCase(),
  };
}

/**
 * Moving-average cost method per symbol.
 * Realized P/L is computed at each SELL using current avg cost basis.
 */
function computeStockMetrics(transactions, quoteMap) {
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

    if (!bySymbol[symbol]) {
      bySymbol[symbol] = { shares: 0, cost: 0, avg: 0, realized: 0, buys: 0, sells: 0 };
    }
    const s = bySymbol[symbol];

    if (type === "BUY") {
      const addCost = shares * price + fees;
      s.shares += shares;
      s.cost += addCost;
      s.buys += 1;
      s.avg = s.shares > 0 ? s.cost / s.shares : 0;
    } else if (type === "SELL") {
      const sellShares = Math.min(shares, s.shares);
      const proceeds = sellShares * price - fees;
      const basis = sellShares * (s.avg || 0);
      const realized = proceeds - basis;

      s.shares -= sellShares;
      s.cost -= basis;
      s.sells += 1;
      s.realized += realized;
      s.avg = s.shares > 0 ? s.cost / s.shares : 0;
    }
  }

  const holdings = Object.entries(bySymbol)
    .map(([symbol, s]) => {
      const q = quoteMap[symbol];
      const spot = safeNum(q?.price, 0);
      const mv = s.shares * spot;
      const unrl = (spot - (s.avg || 0)) * s.shares;

      return {
        symbol,
        shares: s.shares,
        avgCost: s.avg,
        spot,
        marketValue: mv,
        unrealized: unrl,
        realized: s.realized,
        buys: s.buys,
        sells: s.sells,
        quoteTs: q?.timestamp,
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue);

  const totals = holdings.reduce(
    (acc, h) => {
      acc.holdingValue += h.marketValue;
      acc.unrealized += h.unrealized;
      acc.realized += h.realized;
      return acc;
    },
    { holdingValue: 0, unrealized: 0, realized: 0 }
  );

  return {
    holdings,
    totals: {
      holdingValue: round2(totals.holdingValue),
      unrealized: round2(totals.unrealized),
      realized: round2(totals.realized),
      totalPL: round2(totals.unrealized + totals.realized),
    },
  };
}

/* ---------------- Component ---------------- */

export default function Stocks() {
  const [tx, setTx] = useState([]);

  const [quotes, setQuotes] = useState({}); // { AAPL: {price, prevClose, ...} }
  const [quoteStatus, setQuoteStatus] = useState("");

  const [form, setForm] = useState(DEFAULT_FORM);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("date");
  const [sortDir, setSortDir] = useState("desc");

  const symbols = useMemo(() => {
    const set = new Set(
      tx.map((t) => String(t.symbol || "").toUpperCase()).filter(Boolean)
    );
    const fSym = String(form.symbol || "").toUpperCase().trim();
    if (fSym) set.add(fSym);
    return Array.from(set).sort();
  }, [tx, form.symbol]);

  const metrics = useMemo(() => computeStockMetrics(tx, quotes), [tx, quotes]);

  const filteredSortedTx = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = tx;

    if (q) {
      list = list.filter((t) => {
        const hay = `${t.type || ""} ${t.symbol || ""} ${t.notes || ""}`.toLowerCase();
        return hay.includes(q);
      });
    }

    const dir = sortDir === "asc" ? 1 : -1;

    const getVal = (t) => {
      switch (sortKey) {
        case "symbol":
          return t.symbol || "";
        case "type":
          return t.type || "";
        case "shares":
          return safeNum(t.shares, 0);
        case "price":
          return safeNum(t.price, 0);
        case "date":
        default:
          return t.date || "";
      }
    };

    return [...list].sort((a, b) => {
      const va = getVal(a);
      const vb = getVal(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [tx, search, sortKey, sortDir]);

  useEffect(() => {
    let alive = true;

    async function loadTxAndQuotes() {
      setLoading(true);
      setError("");
      setQuoteStatus("");

      try {
        const txRes = await apiFetch("/assets/stocks/transactions");
        if (!alive) return;

        const list = Array.isArray(txRes?.items) ? txRes.items : Array.isArray(txRes) ? txRes : [];
        const norm = list.map(normalizeTx);
        setTx(norm);

        const sym = Array.from(new Set(norm.map((t) => t.symbol).filter(Boolean))).sort();
        if (sym.length) {
          await refreshQuotes(sym);
        } else {
          setQuoteStatus("Add a transaction to start tracking holdings.");
        }
      } catch (e) {
        if (!alive) return;
        setError(e?.message || "Failed to load stock transactions");
        setTx([]);
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    }

    loadTxAndQuotes();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshTxList() {
    const txRes = await apiFetch("/assets/stocks/transactions");
    const list = Array.isArray(txRes?.items) ? txRes.items : Array.isArray(txRes) ? txRes : [];
    const norm = list.map(normalizeTx);
    setTx(norm);

    const sym = Array.from(new Set(norm.map((t) => t.symbol).filter(Boolean))).sort();
    if (sym.length) {
      await refreshQuotes(sym);
    }
  }

  async function refreshQuotes(symList = symbols) {
    if (!symList.length) return;

    try {
      setQuoteStatus("Refreshing quotes…");
      const qs = `?stocks=${encodeURIComponent(symList.join(","))}`;
      const res = await apiFetch(`/prices${qs}`);

      // res.stocks expected: { AAPL: { price, prevClose, ... } }
      const stockMap = res?.stocks || {};
      setQuotes((prev) => ({ ...prev, ...stockMap }));

      // Surface any stock-specific errors (per symbol)
      const stockErrors = res?.errors?.stocks;
      if (stockErrors && typeof stockErrors === "object") {
        const bad = Object.keys(stockErrors);
        setQuoteStatus(
          bad.length
            ? `Quotes refreshed (some failed: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? "…" : ""}).`
            : "Quotes refreshed."
        );
      } else {
        setQuoteStatus("Quotes refreshed.");
      }
    } catch (e) {
      setQuoteStatus(e?.message ? `Quote refresh failed: ${e.message}` : "Quote refresh failed.");
    }
  }

  function resetForm() {
    setForm(DEFAULT_FORM);
    setEditingId(null);
    setError("");
  }

  function closeForm() {
    setShowForm(false);
    resetForm();
  }

  function openCreateForm() {
    setError("");
    setEditingId(null);
    setForm(DEFAULT_FORM);
    setShowForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
  }

  function startEdit(t) {
    setError("");
    setEditingId(t.id);
    setForm({
      type: String(t.type || "BUY").toUpperCase(),
      symbol: String(t.symbol || "AAPL").toUpperCase(),
      date: t.date || todayISO(),
      shares: String(t.shares ?? ""),
      price: String(t.price ?? ""),
      fees: String(t.fees ?? ""),
      notes: t.notes || "",
    });
    setShowForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
  }

  function buildPayloadFromForm() {
    const symbol = String(form.symbol || "").toUpperCase().trim();
    const shares = safeNum(form.shares, NaN);
    const price = safeNum(form.price, NaN);
    const fees = safeNum(form.fees, 0);
    const type = String(form.type).toUpperCase();

    if (!symbol) throw new Error("Symbol is required (e.g., AAPL)");
    if (!form.date) throw new Error("Date is required");
    if (!["BUY", "SELL"].includes(type)) throw new Error("Type must be BUY or SELL");
    if (!Number.isFinite(shares) || shares <= 0) throw new Error("Shares must be a positive number");
    if (!Number.isFinite(price) || price <= 0) throw new Error("Price must be a positive number");
    if (!Number.isFinite(fees) || fees < 0) throw new Error("Fees must be valid");

    return {
      type,
      symbol,
      date: form.date,
      shares: Number(shares.toFixed(4)), // allow fractional shares
      price: Number(price.toFixed(4)),
      fees: Number(fees.toFixed(2)),
      notes: form.notes?.trim() || "",
    };
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setSaving(true);

    try {
      const payload = buildPayloadFromForm();

      if (editingId) {
        await apiFetch(`/assets/stocks/transactions/${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          body: payload,
        });
      } else {
        await apiFetch("/assets/stocks/transactions", { method: "POST", body: payload });
      }

      await refreshTxList();
      closeForm();
    } catch (err) {
      setError(err?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(id) {
    setError("");
    const okDel = window.confirm("Delete this stock transaction?");
    if (!okDel) return;

    try {
      setSaving(true);
      await apiFetch(`/assets/stocks/transactions/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refreshTxList();
      if (editingId === id) closeForm();
    } catch (err) {
      setError(err?.message || "Delete failed");
    } finally {
      setSaving(false);
    }
  }

  const asOfDate = todayISO();

  return (
    <div style={{ padding: 16, color: THEME.pageText }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 900, color: THEME.title, letterSpacing: "0.2px" }}>
            Stocks
          </div>
          <div style={{ marginTop: 6, fontSize: 13, color: THEME.muted }}>
            Track stock transactions, holdings, and realized/unrealized performance.
          </div>
        </div>
        <div style={{ fontSize: 12, color: THEME.muted, textAlign: "right" }}>
          As of <span style={{ color: THEME.pageText, fontWeight: 700 }}>{asOfDate}</span>
        </div>
      </div>

      {/* Summary cards */}
      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(4, minmax(180px, 1fr))", gap: 12 }}>
        <SummaryCard title="Total Holding Value" value={formatMoney(metrics.totals.holdingValue)} hint="Based on latest quotes" />
        <SummaryCard title="Unrealized Gain/Loss" value={formatMoney(metrics.totals.unrealized)} hint="Spot vs. avg cost"  valueColor={plColor(metrics.totals.unrealized)} />
        <SummaryCard title="Realized Gain/Loss" value={formatMoney(metrics.totals.realized)} hint="From sell transactions"  valueColor={plColor(metrics.totals.realized)} />
        <SummaryCard title="Total P/L" value={formatMoney(metrics.totals.totalPL)} hint="Realized + Unrealized" />
      </div>

      {/* Holdings (full width) */}
      <div style={{ ...panel, marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>Holdings Overview</div>
            <div style={{ marginTop: 6, fontSize: 12, color: THEME.muted }}>
              {quoteStatus || "Quotes are loaded from /prices?stocks=... (Finnhub)."}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button type="button" onClick={() => refreshQuotes()} style={btnSecondary} disabled={saving || loading}>
              Refresh Quotes
            </button>
            <button type="button" onClick={openCreateForm} style={btnPrimary} disabled={saving || loading}>
              Add Transaction
            </button>
          </div>
        </div>

        <div style={{ marginTop: 10, borderTop: `1px solid ${THEME.rowBorder}` }} />

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <Th>Symbol</Th>
                <Th>Shares</Th>
                <Th>Avg Cost</Th>
                <Th>Spot</Th>
                <Th>Market Value</Th>
                <Th>Unrealized</Th>
                <Th>Realized</Th>
              </tr>
            </thead>
            <tbody>
              {metrics.holdings.length === 0 ? (
                <tr style={{ borderTop: `1px solid ${THEME.rowBorder}` }}>
                  <Td colSpan={7}>
                    <div style={{ padding: "10px 0", color: THEME.muted }}>
                      No holdings yet. Add a BUY transaction.
                    </div>
                  </Td>
                </tr>
              ) : (
                metrics.holdings.map((h) => (
                  <tr key={h.symbol} style={{ borderTop: `1px solid ${THEME.rowBorder}` }}>
                    <Td>
                      <div style={{ fontWeight: 900, color: THEME.title }}>{h.symbol}</div>
                      <div style={{ marginTop: 3, fontSize: 12, color: THEME.muted }}>
                        Buys: {h.buys} · Sells: {h.sells}
                      </div>
                    </Td>
                    <Td>{round2(h.shares).toLocaleString(undefined, { maximumFractionDigits: 4 })}</Td>
                    <Td>{formatMoney(h.avgCost)}</Td>
                    <Td>{formatMoney(h.spot)}</Td>
                    <Td style={{ fontWeight: 900, color: THEME.title }}>{formatMoney(h.marketValue)}</Td>
                    <Td style={{ fontWeight: 900, color: plColor(h.unrealized) }}>{formatMoney(h.unrealized)}</Td>
                    <Td style={{ fontWeight: 900, color: plColor(h.realized) }}>{formatMoney(h.realized)}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add/Edit transaction (hidden by default) */}
      {showForm ? (
        <div style={{ ...panel, marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>
              {editingId ? "Edit Stock Transaction" : "Add Stock Transaction"}
            </div>
            <button type="button" onClick={closeForm} style={btnSecondary} disabled={saving}>
              Close
            </button>
          </div>

          {error ? (
            <div style={{ marginTop: 10, ...callout }}>
              <div style={{ fontWeight: 900, color: THEME.title }}>Error</div>
              <div style={{ marginTop: 4, color: THEME.pageText }}>{error}</div>
            </div>
          ) : null}

          <form onSubmit={onSubmit} style={{ marginTop: 12, display: "grid", gap: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <Field label="Type">
                <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} style={input} disabled={saving}>
                  <option value="BUY">Buy</option>
                  <option value="SELL">Sell</option>
                </select>
              </Field>

              <Field label="Symbol">
                <input
                  value={form.symbol}
                  onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value.toUpperCase() }))}
                  placeholder="e.g., AAPL"
                  style={input}
                  disabled={saving}
                />
              </Field>

              <Field label="Date">
                <input
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                  style={input}
                  disabled={saving}
                />
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <Field label="Shares">
                <input
                  value={form.shares}
                  onChange={(e) => setForm((f) => ({ ...f, shares: e.target.value }))}
                  placeholder="e.g., 10"
                  inputMode="decimal"
                  style={input}
                  disabled={saving}
                />
              </Field>

              <Field label="Price (USD / share)">
                <input
                  value={form.price}
                  onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                  placeholder="e.g., 193.22"
                  inputMode="decimal"
                  style={input}
                  disabled={saving}
                />
              </Field>

              <Field label="Fees (USD)">
                <input
                  value={form.fees}
                  onChange={(e) => setForm((f) => ({ ...f, fees: e.target.value }))}
                  placeholder="0"
                  inputMode="decimal"
                  style={input}
                  disabled={saving}
                />
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: 10 }}>
              <Field label="Notes (optional)">
                <input
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="e.g., earnings buy, long-term"
                  style={input}
                  disabled={saving}
                />
              </Field>

              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", alignItems: "end" }}>
                <button type="button" onClick={resetForm} style={btnSecondary} disabled={saving}>
                  Reset
                </button>
                <button type="submit" style={{ ...btnPrimary, opacity: saving ? 0.75 : 1 }} disabled={saving}>
                  {saving ? "Saving…" : editingId ? "Save Changes" : "Add Transaction"}
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : null}

      {/* Transactions */}
      <div style={{ ...panel, marginTop: 14, paddingBottom: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>Transactions</div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search type/symbol/notes…"
              style={{ ...input, width: 240 }}
              disabled={loading}
            />
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} style={{ ...input, width: 190 }} disabled={loading}>
              <option value="date">Sort: Date</option>
              <option value="symbol">Sort: Symbol</option>
              <option value="type">Sort: Type</option>
              <option value="shares">Sort: Shares</option>
              <option value="price">Sort: Price</option>
            </select>
            <button type="button" onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))} style={btnSecondary} disabled={loading}>
              {sortDir === "asc" ? "Asc" : "Desc"}
            </button>
          </div>
        </div>

        <div style={{ marginTop: 10, borderTop: `1px solid ${THEME.rowBorder}` }} />

        {loading ? (
          <div style={{ padding: 14, color: THEME.muted }}>Loading…</div>
        ) : filteredSortedTx.length === 0 ? (
          <div style={{ padding: 14, color: THEME.muted }}>No stock transactions yet. Add a buy/sell above.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <Th>Date</Th>
                  <Th>Type</Th>
                  <Th>Symbol</Th>
                  <Th>Shares</Th>
                  <Th>Price</Th>
                  <Th>Fees</Th>
                  <Th>Net</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {filteredSortedTx.map((t) => {
                  const type = String(t.type || "BUY").toUpperCase();
                  const shares = safeNum(t.shares, 0);
                  const px = safeNum(t.price, 0);
                  const fees = safeNum(t.fees, 0);
                  const gross = shares * px;
                  const net = type === "SELL" ? gross - fees : gross + fees;

                  return (
                    <tr key={t.id} style={{ borderTop: `1px solid ${THEME.rowBorder}` }}>
                      <Td>{t.date || "-"}</Td>
                      <Td>
                        <span style={{ fontWeight: 900, color: THEME.title }}>{type}</span>
                      </Td>
                      <Td>{String(t.symbol || "").toUpperCase()}</Td>
                      <Td>{shares.toLocaleString(undefined, { maximumFractionDigits: 4 })}</Td>
                      <Td>{formatMoney(px)}</Td>
                      <Td>{formatMoney(fees)}</Td>
                      <Td style={{ fontWeight: 900, color: THEME.title }}>{formatMoney(net)}</Td>
                      <Td align="right">
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingRight: 8 }}>
                          <button type="button" onClick={() => startEdit(t)} style={btnSecondarySmall} disabled={saving}>
                            Edit
                          </button>
                          <button type="button" onClick={() => onDelete(t.id)} style={btnDangerSmall} disabled={saving}>
                            Delete
                          </button>
                        </div>
                        {t.notes ? (
                          <div style={{ marginTop: 6, fontSize: 12, color: THEME.muted, paddingRight: 8 }}>
                            {t.notes}
                          </div>
                        ) : null}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- UI helpers ---------- */

function SummaryCard({ title, value, hint, valueColor }) {
  return (
    <div style={panel}>
      <div style={{ fontSize: 12, color: THEME.muted, fontWeight: 800 }}>{title}</div>
      <div style={{ marginTop: 6, fontSize: 18, fontWeight: 900, color: valueColor || THEME.title }}>{value}</div>
      {hint ? <div style={{ marginTop: 6, fontSize: 12, color: THEME.muted }}>{hint}</div> : null}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <div style={{ fontSize: 12, color: THEME.muted, fontWeight: 800 }}>{label}</div>
      {children}
    </label>
  );
}

function Th({ children, align, style, ...rest }) {
  return (
    <th
      style={{
        padding: "10px 10px",
        fontSize: 12,
        color: THEME.muted,
        fontWeight: 900,
        whiteSpace: "nowrap",
        ...(style || {}),
      }}
      align={align || "left"}
      {...rest}
    >
      {children}
    </th>
  );
}

function Td({ children, align, colSpan, style, ...rest }) {
  return (
    <td
      style={{ padding: "12px 10px", verticalAlign: "top", ...(style || {}) }}
      align={align || "left"}
      colSpan={colSpan}
      {...rest}
    >
      {children}
    </td>
  );
}

/* ---------- styles ---------- */

const panel = {
  background: THEME.panelBg,
  border: `1px solid ${THEME.panelBorder}`,
  borderRadius: 14,
  padding: 14,
  backdropFilter: "blur(6px)",
};

const input = {
  width: "100%",
  padding: "10px 10px",
  borderRadius: 12,
  border: `1px solid ${THEME.inputBorder}`,
  background: THEME.inputBg,
  color: THEME.pageText,
  outline: "none",
};

const btnPrimary = {
  padding: "10px 12px",
  borderRadius: 12,
  border: `1px solid ${THEME.primaryBorder}`,
  background: THEME.primaryBg,
  color: THEME.title,
  fontWeight: 900,
  cursor: "pointer",
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

const btnSecondarySmall = {
  padding: "7px 10px",
  borderRadius: 12,
  border: `1px solid ${THEME.panelBorder}`,
  background: "rgba(148, 163, 184, 0.06)",
  color: THEME.pageText,
  fontWeight: 900,
  cursor: "pointer",
  fontSize: 12,
};

const btnDangerSmall = {
  padding: "7px 10px",
  borderRadius: 12,
  border: `1px solid ${THEME.dangerBorder}`,
  background: THEME.dangerBg,
  color: THEME.title,
  fontWeight: 900,
  cursor: "pointer",
  fontSize: 12,
};

const callout = {
  padding: 12,
  borderRadius: 12,
  background: "rgba(239, 68, 68, 0.10)",
  border: `1px solid ${THEME.dangerBorder}`,
};
