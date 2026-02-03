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


/* ---------------- API (same auth pattern) ---------------- */

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

const METALS = [
  { key: "GOLD", label: "Gold", unit: "oz" },
  { key: "SILVER", label: "Silver", unit: "oz" },
];

const DEFAULT_FORM = {
  type: "BUY",
  metal: "GOLD",
  date: todayISO(),
  quantityOz: "",
  unitPrice: "",
  fees: "",
  notes: "",
};

function normalizeTx(item) {
  return {
    ...item,
    id: item.txId || item.assetId || item.id,
  };
}

function computeBullionMetrics(transactions, spot) {
  const state = {};
  for (const m of METALS) {
    state[m.key] = { qty: 0, cost: 0, avg: 0, realized: 0, buys: 0, sells: 0 };
  }

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
      s.buys += 1;
      s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    } else if (type === "SELL") {
      const sellQty = Math.min(qty, s.qty);
      const proceeds = sellQty * price - fees;
      const basis = sellQty * (s.avg || 0);
      const realized = proceeds - basis;

      s.qty -= sellQty;
      s.cost -= basis;
      s.sells += 1;
      s.realized += realized;
      s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    }
  }

  let holdingValue = 0;
  let unrealized = 0;
  let realized = 0;

  const holdings = METALS.map((m) => {
    const s = state[m.key];
    const spotPx = safeNum(spot[m.key], 0);
    const mv = s.qty * spotPx;
    const unrl = (spotPx - (s.avg || 0)) * s.qty;

    holdingValue += mv;
    unrealized += unrl;
    realized += s.realized;

    return {
      metal: m.key,
      label: m.label,
      qty: s.qty,
      avgCost: s.avg,
      spot: spotPx,
      marketValue: mv,
      unrealized: unrl,
      realized: s.realized,
      buys: s.buys,
      sells: s.sells,
    };
  });

  return {
    holdings,
    totals: {
      holdingValue: round2(holdingValue),
      unrealized: round2(unrealized),
      realized: round2(realized),
      totalPL: round2(unrealized + realized),
    },
  };
}

/* ---------------- Component ---------------- */

export default function Bullion() {
  const [tx, setTx] = useState([]);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const [spot, setSpot] = useState({ GOLD: 0, SILVER: 0 });
  const [spotStatus, setSpotStatus] = useState("");

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("date");
  const [sortDir, setSortDir] = useState("desc");

  useEffect(() => {
    let alive = true;

    async function loadAll() {
      setLoading(true);
      setError("");

      try {
        const [txRes, pricesRes] = await Promise.allSettled([
          apiFetch("/assets/bullion/transactions"),
          apiFetch("/prices"),
        ]);

        if (!alive) return;

        if (txRes.status === "fulfilled") {
          const list = Array.isArray(txRes.value?.items)
            ? txRes.value.items
            : Array.isArray(txRes.value)
            ? txRes.value
            : [];
          setTx(list.map(normalizeTx));
        } else {
          setTx([]);
          setError(txRes.reason?.message || "Failed to load bullion transactions");
        }

        if (pricesRes.status === "fulfilled") {
          const goldPrice = safeNum(pricesRes.value?.gold?.price, 0);
          const silverPrice = safeNum(pricesRes.value?.silver?.price, 0);
          setSpot({ GOLD: round2(goldPrice), SILVER: round2(silverPrice) });
          setSpotStatus("Spot prices loaded.");
        } else {
          setSpotStatus(
            pricesRes.reason?.message ? `Spot load failed: ${pricesRes.reason.message}` : "Spot load failed."
          );
        }
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    }

    loadAll();
    return () => {
      alive = false;
    };
  }, []);

  const metrics = useMemo(() => computeBullionMetrics(tx, spot), [tx, spot]);

  const filteredSortedTx = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = tx;

    if (q) {
      list = list.filter((t) => {
        const hay = `${t.type || ""} ${t.metal || ""} ${t.notes || ""}`.toLowerCase();
        return hay.includes(q);
      });
    }

    const dir = sortDir === "asc" ? 1 : -1;

    const getVal = (t) => {
      switch (sortKey) {
        case "metal":
          return t.metal || "";
        case "type":
          return t.type || "";
        case "quantityOz":
          return safeNum(t.quantityOz, 0);
        case "unitPrice":
          return safeNum(t.unitPrice, 0);
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
      metal: String(t.metal || "GOLD").toUpperCase(),
      date: t.date || todayISO(),
      quantityOz: String(t.quantityOz ?? ""),
      unitPrice: String(t.unitPrice ?? ""),
      fees: String(t.fees ?? ""),
      notes: t.notes || "",
    });
    setShowForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
  }

  function buildPayloadFromForm() {
    const qty = safeNum(form.quantityOz, NaN);
    const px = safeNum(form.unitPrice, NaN);
    const fees = safeNum(form.fees, 0);

    if (!form.date) throw new Error("Date is required");
    if (!["BUY", "SELL"].includes(String(form.type).toUpperCase())) throw new Error("Type must be BUY or SELL");
    if (!METALS.some((m) => m.key === String(form.metal).toUpperCase())) throw new Error("Metal must be valid");
    if (!Number.isFinite(qty) || qty <= 0) throw new Error("Quantity must be a positive number (oz)");
    if (!Number.isFinite(px) || px <= 0) throw new Error("Unit price must be a positive number");
    if (!Number.isFinite(fees) || fees < 0) throw new Error("Fees must be valid");

    return {
      type: String(form.type).toUpperCase(),
      metal: String(form.metal).toUpperCase(),
      date: form.date,
      quantityOz: round2(qty),
      unitPrice: round2(px),
      fees: round2(fees),
      notes: form.notes?.trim() || "",
    };
  }

  async function refreshTxList() {
    const res = await apiFetch("/assets/bullion/transactions");
    const list = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
    setTx(list.map(normalizeTx));
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setSaving(true);

    try {
      const payload = buildPayloadFromForm();

      if (editingId) {
        await apiFetch(`/assets/bullion/transactions/${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          body: payload,
        });
      } else {
        await apiFetch("/assets/bullion/transactions", { method: "POST", body: payload });
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
    const okDel = window.confirm("Delete this bullion transaction?");
    if (!okDel) return;

    try {
      setSaving(true);
      await apiFetch(`/assets/bullion/transactions/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refreshTxList();
      if (editingId === id) closeForm();
    } catch (err) {
      setError(err?.message || "Delete failed");
    } finally {
      setSaving(false);
    }
  }

  async function refreshSpot() {
    setSpotStatus("");
    try {
      const res = await apiFetch("/prices");
      const goldPrice = safeNum(res?.gold?.price, 0);
      const silverPrice = safeNum(res?.silver?.price, 0);
      setSpot({ GOLD: round2(goldPrice), SILVER: round2(silverPrice) });
      setSpotStatus("Spot prices refreshed.");
    } catch (e) {
      setSpotStatus(e?.message ? `Spot refresh failed: ${e.message}` : "Spot refresh failed.");
    }
  }

  const asOfDate = todayISO();

  return (
    <div style={{ padding: 16, color: THEME.pageText }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 900, color: THEME.title, letterSpacing: "0.2px" }}>
            Bullion
          </div>
          <div style={{ marginTop: 6, fontSize: 13, color: THEME.muted }}>
            Track Gold/Silver buys & sells, holdings, and realized/unrealized performance.
          </div>
        </div>
        <div style={{ fontSize: 12, color: THEME.muted, textAlign: "right" }}>
          As of <span style={{ color: THEME.pageText, fontWeight: 700 }}>{asOfDate}</span>
        </div>
      </div>

      {/* Summary cards */}
      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(4, minmax(180px, 1fr))", gap: 12 }}>
        <SummaryCard title="Total Holding Value" value={formatMoney(metrics.totals.holdingValue)} hint="Based on spot prices" />
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
              {spotStatus || "Spot prices are used in calculations (loaded from /prices)."}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button type="button" onClick={refreshSpot} style={btnSecondary} disabled={saving || loading}>
              Refresh Prices
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
                <Th>Metal</Th>
                <Th>Qty (oz)</Th>
                <Th>Avg Cost</Th>
                <Th>Spot</Th>
                <Th>Market Value</Th>
                <Th>Unrealized</Th>
                <Th>Realized</Th>
              </tr>
            </thead>
            <tbody>
              {metrics.holdings.map((h) => (
                <tr key={h.metal} style={{ borderTop: `1px solid ${THEME.rowBorder}` }}>
                  <Td>
                    <div style={{ fontWeight: 900, color: THEME.title }}>{h.label}</div>
                    <div style={{ marginTop: 3, fontSize: 12, color: THEME.muted }}>
                      Buys: {h.buys} · Sells: {h.sells}
                    </div>
                  </Td>
                  <Td>{round2(h.qty).toLocaleString(undefined, { maximumFractionDigits: 2 })}</Td>
                  <Td>{formatMoney(h.avgCost)}</Td>
                  <Td>{formatMoney(h.spot)}</Td>
                  <Td style={{ fontWeight: 900, color: THEME.title }}>{formatMoney(h.marketValue)}</Td>
                  <Td style={{ fontWeight: 900, color: plColor(h.unrealized) }}>{formatMoney(h.unrealized)}</Td>
                  <Td style={{ fontWeight: 900, color: plColor(h.realized) }}>{formatMoney(h.realized)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add/Edit transaction (hidden by default) */}
      {showForm ? (
        <div style={{ ...panel, marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>
              {editingId ? "Edit Bullion Transaction" : "Add Bullion Transaction"}
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

              <Field label="Metal">
                <select value={form.metal} onChange={(e) => setForm((f) => ({ ...f, metal: e.target.value }))} style={input} disabled={saving}>
                  {METALS.map((m) => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </select>
              </Field>

              <Field label="Date">
                <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} style={input} disabled={saving} />
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <Field label="Quantity (oz)">
                <input value={form.quantityOz} onChange={(e) => setForm((f) => ({ ...f, quantityOz: e.target.value }))} placeholder="e.g., 2.00" inputMode="decimal" style={input} disabled={saving} />
              </Field>

              <Field label="Unit Price (USD / oz)">
                <input value={form.unitPrice} onChange={(e) => setForm((f) => ({ ...f, unitPrice: e.target.value }))} placeholder="e.g., 2050" inputMode="decimal" style={input} disabled={saving} />
              </Field>

              <Field label="Fees (USD)">
                <input value={form.fees} onChange={(e) => setForm((f) => ({ ...f, fees: e.target.value }))} placeholder="0" inputMode="decimal" style={input} disabled={saving} />
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: 10 }}>
              <Field label="Notes (optional)">
                <input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="e.g., dealer premium, Costco coin, etc." style={input} disabled={saving} />
              </Field>

              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", alignItems: "end" }}>
                <button type="button" onClick={resetForm} style={btnSecondary} disabled={saving}>Reset</button>
                <button type="submit" style={{ ...btnPrimary, opacity: saving ? 0.75 : 1 }} disabled={saving}>
                  {saving ? "Saving…" : editingId ? "Save Changes" : "Add Transaction"}
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : null}

      {/* Transactions table (unchanged behavior) */}
      <div style={{ ...panel, marginTop: 14, paddingBottom: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>Transactions</div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search type/metal/notes…" style={{ ...input, width: 240 }} disabled={loading} />
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} style={{ ...input, width: 190 }} disabled={loading}>
              <option value="date">Sort: Date</option>
              <option value="metal">Sort: Metal</option>
              <option value="type">Sort: Type</option>
              <option value="quantityOz">Sort: Quantity</option>
              <option value="unitPrice">Sort: Unit Price</option>
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
          <div style={{ padding: 14, color: THEME.muted }}>No bullion transactions yet. Add a buy/sell above.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <Th>Date</Th><Th>Type</Th><Th>Metal</Th><Th>Qty (oz)</Th><Th>Unit Price</Th><Th>Fees</Th><Th>Net</Th><Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {filteredSortedTx.map((t) => {
                  const type = String(t.type || "BUY").toUpperCase();
                  const qty = safeNum(t.quantityOz, 0);
                  const px = safeNum(t.unitPrice, 0);
                  const fees = safeNum(t.fees, 0);
                  const gross = qty * px;
                  const net = type === "SELL" ? gross - fees : gross + fees;

                  return (
                    <tr key={t.id} style={{ borderTop: `1px solid ${THEME.rowBorder}` }}>
                      <Td>{t.date || "-"}</Td>
                      <Td><span style={{ fontWeight: 900, color: THEME.title }}>{type}</span></Td>
                      <Td>{String(t.metal || "").toUpperCase()}</Td>
                      <Td>{round2(qty).toLocaleString(undefined, { maximumFractionDigits: 2 })}</Td>
                      <Td>{formatMoney(px)}</Td>
                      <Td>{formatMoney(fees)}</Td>
                      <Td style={{ fontWeight: 900, color: THEME.title }}>{formatMoney(net)}</Td>
                      <Td align="right">
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingRight: 8 }}>
                          <button type="button" onClick={() => startEdit(t)} style={btnSecondarySmall} disabled={saving}>Edit</button>
                          <button type="button" onClick={() => onDelete(t.id)} style={btnDangerSmall} disabled={saving}>Delete</button>
                        </div>
                        {t.notes ? <div style={{ marginTop: 6, fontSize: 12, color: THEME.muted, paddingRight: 8 }}>{t.notes}</div> : null}
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
