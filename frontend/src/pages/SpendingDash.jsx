import { useEffect, useMemo, useState } from "react";

/* ---------------- Theme (match your assets pages) ---------------- */

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
};

function formatMoney(n) {
  const x = Number(n || 0);
  return x.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/* ---------------- API helpers (same pattern as other pages) ---------------- */

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

/* ---------------- Horizontal bar chart (no external libs) ---------------- */

function HorizontalBarChart({ data, expanded, onToggle, detailsByCategory, loadingCat }) {
  const max = useMemo(() => {
    return data.reduce((m, x) => Math.max(m, Number(x.amount || 0)), 0) || 1;
  }, [data]);

  // Column layout for drilldown rows:
  // Date | Description | Category | Amount
  const rowCols = "120px minmax(240px, 1fr) 220px 120px";

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {data.map((d) => {
        const amt = Number(d.amount || 0);
        const pct = clamp((amt / max) * 100, 0, 100);

        const isOpen = !!expanded[d.category];
        const det = detailsByCategory[d.category];

        return (
          <div key={d.category} style={{ display: "grid", gap: 10 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "240px 1fr 130px",
                gap: 12,
                alignItems: "center",
              }}
            >
              {/* Category label + expand/collapse */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  minWidth: 0,
                }}
                title={d.category}
              >
                <button
                  type="button"
                  onClick={() => onToggle(d.category)}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 10,
                    border: `1px solid ${THEME.inputBorder}`,
                    background: "rgba(255,255,255,0.06)",
                    color: THEME.title,
                    fontWeight: 900,
                    cursor: "pointer",
                    lineHeight: "24px",
                  }}
                  aria-label={isOpen ? `Collapse ${d.category}` : `Expand ${d.category}`}
                >
                  {isOpen ? "–" : "+"}
                </button>

                <div
                  style={{
                    fontWeight: 800,
                    color: THEME.pageText,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {d.category}
                </div>
              </div>

              {/* Track */}
              <div
                style={{
                  height: 14,
                  borderRadius: 999,
                  border: `1px solid ${THEME.panelBorder}`,
                  background: "rgba(255,255,255,0.06)",
                  overflow: "hidden",
                  boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.15)",
                }}
                title={`${d.category}: ${formatMoney(amt)}`}
              >
                {/* Fill */}
                <div
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    background: "rgba(34,211,238,0.65)",
                    borderRight: "1px solid rgba(34,211,238,0.95)",
                    boxShadow: "0 0 14px rgba(34,211,238,0.25)",
                  }}
                />
              </div>

              <div style={{ textAlign: "right", fontWeight: 900, color: THEME.title }}>
                {formatMoney(amt)}
              </div>
            </div>

            {/* Drilldown */}
            {isOpen ? (
              <div
                style={{
                  border: `1px solid ${THEME.rowBorder}`,
                  borderRadius: 12,
                  padding: 12,
                  background: "rgba(255,255,255,0.03)",
                }}
              >
                {loadingCat === d.category ? (
                  <div style={{ color: THEME.muted }}>Loading line items…</div>
                ) : !det ? (
                  <div style={{ color: THEME.muted }}>No details loaded.</div>
                ) : det.error ? (
                  <div style={{ color: THEME.muted }}>Error: {det.error}</div>
                ) : det.items?.length ? (
                  <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <div style={{ fontWeight: 900, color: THEME.title }}>
                        {d.category} line items
                      </div>
                      <div style={{ color: THEME.muted, fontSize: 12 }}>
                        {det.count} items · {formatMoney(det.total)}
                      </div>
                    </div>

                    <div style={{ borderTop: `1px solid ${THEME.rowBorder}` }} />

                    {/* Column header row */}
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: rowCols,
                        gap: 10,
                        padding: "6px 0",
                        color: THEME.muted,
                        fontSize: 11,
                        fontWeight: 900,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                      }}
                    >
                      <div>Date</div>
                      <div>Description</div>
                      <div>Category</div>
                      <div style={{ textAlign: "right" }}>Amount</div>
                    </div>

                    <div style={{ borderTop: `1px solid ${THEME.rowBorder}` }} />

                    <div style={{ display: "grid", gap: 0 }}>
                      {det.items.slice(0, 80).map((it) => {
                        const catText =
                          it.category ||
                          it.categoryName ||
                          it.categoryLabel ||
                          "—";

                        return (
                          <div
                            key={`${it.pk}||${it.sk}`}
                            style={{
                              display: "grid",
                              gridTemplateColumns: rowCols,
                              gap: 10,
                              alignItems: "center",
                              padding: "10px 0",
                              borderBottom: `1px solid ${THEME.rowBorder}`,
                            }}
                          >
                            {/* Date */}
                            <div
                              style={{
                                color: THEME.muted,
                                fontSize: 12,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {it.date || ""}
                            </div>

                            {/* Product Description */}
                            <div style={{ minWidth: 0 }}>
                              <div
                                style={{
                                  color: THEME.pageText,
                                  fontWeight: 800,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                                title={it.productDescription || ""}
                              >
                                {it.productDescription || "(no description)"}
                              </div>
                              {it.productCode ? (
                                <div
                                  style={{
                                    color: THEME.muted,
                                    fontSize: 12,
                                    marginTop: 2,
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                  }}
                                  title={`Code: ${it.productCode}`}
                                >
                                  Code: {it.productCode}
                                </div>
                              ) : null}
                            </div>

                            {/* Category */}
                            <div
                              style={{
                                color: THEME.pageText,
                                fontWeight: 800,
                                opacity: 0.95,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                              title={catText}
                            >
                              {catText}
                            </div>

                            {/* Amount */}
                            <div
                              style={{
                                textAlign: "right",
                                fontWeight: 900,
                                color: THEME.title,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {formatMoney(Number(it.amount || 0))}
                            </div>
                          </div>
                        );
                      })}

                      {det.items.length > 80 ? (
                        <div style={{ color: THEME.muted, fontSize: 12, paddingTop: 8 }}>
                          Showing top 80 items. Narrow your date range to see fewer.
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div style={{ color: THEME.muted }}>No line items in this category.</div>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- Page ---------------- */

export default function SpendingDash() {
  // presets
  const presets = useMemo(
    () => [
      { key: "7D", label: "Last 7 days", days: 7 },
      { key: "30D", label: "Last 30 days", days: 30 },
      { key: "90D", label: "Last 90 days", days: 90 },
      { key: "YTD", label: "Year to date", days: null },
      { key: "CUSTOM", label: "Custom", days: null },
    ],
    []
  );

  const [preset, setPreset] = useState("30D");

  const [start, setStart] = useState(addDays(todayISO(), -29));
  const [end, setEnd] = useState(todayISO());

  const [category, setCategory] = useState("All");
  const [categories, setCategories] = useState(["All"]);

  const [totalSpend, setTotalSpend] = useState(0);
  const [chart, setChart] = useState([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState({});

  const [detailsByCategory, setDetailsByCategory] = useState({});
  const [loadingCat, setLoadingCat] = useState("");

  // apply preset to dates (except CUSTOM)
  useEffect(() => {
    const t = todayISO();

    if (preset === "7D") {
      setStart(addDays(t, -6));
      setEnd(t);
    } else if (preset === "30D") {
      setStart(addDays(t, -29));
      setEnd(t);
    } else if (preset === "90D") {
      setStart(addDays(t, -89));
      setEnd(t);
    } else if (preset === "YTD") {
      const year = new Date().getFullYear();
      setStart(`${year}-01-01`);
      setEnd(t);
    }
  }, [preset]);

  async function loadCategoryDetails(cat) {
    setLoadingCat(cat);
    try {
      const qs = new URLSearchParams({ start, end, category: cat }).toString();
      const res = await apiFetch(`/spending/dashboard/details?${qs}`);

      setDetailsByCategory((prev) => ({
        ...prev,
        [cat]: { ...res, error: "" },
      }));
    } catch (e) {
      setDetailsByCategory((prev) => ({
        ...prev,
        [cat]: { error: e?.message || "Failed to load details", items: [], count: 0, total: 0 },
      }));
    } finally {
      setLoadingCat("");
    }
  }

  function toggleCategory(cat) {
    setExpanded((prev) => {
      const next = { ...prev, [cat]: !prev[cat] };
      return next;
    });

    // If opening and we don't have details yet, fetch them
    if (!expanded[cat] && !detailsByCategory[cat]) {
      loadCategoryDetails(cat);
    }
  }

  async function loadDashboard({ s = start, e = end, c = category } = {}) {
    setLoading(true);
    setError("");

    try {
      const qs = new URLSearchParams({
        start: s,
        end: e,
        category: c || "All",
      }).toString();

      const res = await apiFetch(`/spending/dashboard?${qs}`);

      setTotalSpend(Number(res?.totalSpend || 0));
      setChart(Array.isArray(res?.chart) ? res.chart : []);
      setCategories(Array.isArray(res?.categories) ? res.categories : ["All"]);

      // backend returns normalized category name; keep UI in sync
      if (res?.category && res.category !== c) setCategory(res.category);
    } catch (e2) {
      setError(e2?.message || "Failed to load dashboard");
      setTotalSpend(0);
      setChart([]);
      setCategories(["All"]);
    } finally {
      setLoading(false);
    }
  }

  // initial load + reload when filters change
  useEffect(() => {
    loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, category]);

  useEffect(() => {
    setExpanded({});
    setDetailsByCategory({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, category]);

  const asOf = todayISO();

  return (
    <div style={{ padding: 16, color: THEME.pageText }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 900, color: THEME.title, letterSpacing: "0.2px" }}>
            Spending Dashboard
          </div>
          <div style={{ marginTop: 6, fontSize: 13, color: THEME.muted }}>
            Insights from your receipts ledger (Subtotal/Total excluded; Tax tracked separately).
          </div>
        </div>
        <div style={{ fontSize: 12, color: THEME.muted, textAlign: "right" }}>
          As of <span style={{ color: THEME.pageText, fontWeight: 700 }}>{asOf}</span>
        </div>
      </div>

      {/* Summary card with filters */}
      <div style={{ ...panel, marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 12, color: THEME.muted, fontWeight: 800 }}>Total Spend</div>
            <div style={{ marginTop: 6, fontSize: 22, fontWeight: 900, color: THEME.title }}>
              {loading ? "Loading…" : formatMoney(totalSpend)}
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: THEME.muted }}>
              {start} → {end} {category && category !== "All" ? `· Category: ${category}` : ""}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
            <Field label="Date Range">
              <select value={preset} onChange={(e) => setPreset(e.target.value)} style={{ ...input, width: 160 }}>
                {presets.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Start">
              <input
                type="date"
                value={start}
                onChange={(e) => {
                  setPreset("CUSTOM");
                  setStart(e.target.value);
                }}
                style={{ ...input, width: 160 }}
              />
            </Field>

            <Field label="End">
              <input
                type="date"
                value={end}
                onChange={(e) => {
                  setPreset("CUSTOM");
                  setEnd(e.target.value);
                }}
                style={{ ...input, width: 160 }}
              />
            </Field>

            <Field label="Category">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                style={{ ...input, width: 220 }}
              >
                {(categories?.length ? categories : ["All"]).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>

            <button
              type="button"
              onClick={() => loadDashboard({ s: start, e: end, c: category })}
              style={btnPrimary}
              disabled={loading}
            >
              Refresh
            </button>
          </div>
        </div>

        {error ? (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 12, border: `1px solid rgba(239,68,68,0.35)`, background: "rgba(239,68,68,0.10)" }}>
            <div style={{ fontWeight: 900, color: THEME.title }}>Error</div>
            <div style={{ marginTop: 4, color: THEME.pageText }}>{error}</div>
          </div>
        ) : null}
      </div>

      {/* Category insights */}
      <div style={{ ...panel, marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>
              Category Insights
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: THEME.muted }}>
              Top 10 categories by spend (remaining grouped as “Others”).
            </div>
          </div>
        </div>

        <div style={{ marginTop: 12, borderTop: `1px solid ${THEME.rowBorder}` }} />

        <div style={{ marginTop: 12 }}>
          {loading ? (
            <div style={{ color: THEME.muted }}>Loading chart…</div>
          ) : chart.length === 0 ? (
            <div style={{ color: THEME.muted }}>No spend data for the selected period.</div>
          ) : (
            <HorizontalBarChart
              data={chart}
              expanded={expanded}
              onToggle={toggleCategory}
              detailsByCategory={detailsByCategory}
              loadingCat={loadingCat}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Small UI bits ---------- */

function Field({ label, children }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <div style={{ fontSize: 12, color: THEME.muted, fontWeight: 800 }}>{label}</div>
      {children}
    </label>
  );
}

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
