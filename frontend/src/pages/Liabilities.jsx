import { useEffect, useMemo, useState } from "react";

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
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
function round2(n) {
  return Math.round(safeNum(n, 0) * 100) / 100;
}
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

/* ---------------- API wiring ---------------- */
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
    sessionStorage.getItem("token") ||
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
    throw new Error(`API returned non-JSON (${res.status}). First chars: ${text.slice(0, 30)}`);
  }

  if (!res.ok) {
    throw new Error(data?.error || data?.message || `Request failed (${res.status})`);
  }

  return data;
}

function normalizeApiRow(item) {
  const c = String(item?.country || "").trim();
  const country = c ? (c.toUpperCase() === "INDIA" ? "INDIA" : "USA") : "USA";
  return {
    ...item,
    country,
    id: item.liabilityId || item.assetId || item.id,
  };
}

/* ---------------- UI bits ---------------- */

const COUNTRY_OPTIONS = ["USA", "India"];
const CATEGORY_OPTIONS = [
  "Credit Card",
  "Auto Loan",
  "Mortgage",
  "Personal Loan",
  "Student Loan",
  "Margin / Broker Loan",
  "Other",
];

const DEFAULT_FORM = {
  category: "Credit Card",
  country: "USA",
  description: "",
  remarks: "",
  value: "",
};

const panel = {
  background: THEME.panelBg,
  border: `1px solid ${THEME.panelBorder}`,
  borderRadius: 14,
  padding: 12,
};

const callout = {
  background: "rgba(239, 68, 68, 0.10)",
  border: `1px solid ${THEME.dangerBorder}`,
  borderRadius: 12,
  padding: 10,
};

const input = {
  width: "100%",
  background: THEME.inputBg,
  border: `1px solid ${THEME.inputBorder}`,
  color: THEME.pageText,
  padding: "8px 10px",
  borderRadius: 10,
  outline: "none",
};

const btnPrimary = {
  background: THEME.primaryBg,
  border: `1px solid ${THEME.primaryBorder}`,
  color: THEME.title,
  padding: "9px 12px",
  borderRadius: 12,
  cursor: "pointer",
  fontWeight: 900,
};

const btnSecondary = {
  background: THEME.inputBg,
  border: `1px solid ${THEME.inputBorder}`,
  color: THEME.pageText,
  padding: "9px 12px",
  borderRadius: 12,
  cursor: "pointer",
  fontWeight: 900,
};

const btnDangerSmall = {
  background: THEME.dangerBg,
  border: `1px solid ${THEME.dangerBorder}`,
  color: THEME.title,
  padding: "7px 10px",
  borderRadius: 10,
  cursor: "pointer",
  fontWeight: 900,
};

const btnSecondarySmall = {
  background: THEME.inputBg,
  border: `1px solid ${THEME.inputBorder}`,
  color: THEME.pageText,
  padding: "7px 10px",
  borderRadius: 10,
  cursor: "pointer",
  fontWeight: 900,
};

function SummaryCard({ title, value, hint }) {
  return (
    <div
      style={{
        background: THEME.panelBg,
        border: `1px solid ${THEME.panelBorder}`,
        borderRadius: 14,
        padding: 12,
      }}
    >
      <div style={{ color: THEME.muted, fontSize: 12, fontWeight: 900 }}>{title}</div>
      <div style={{ marginTop: 6, fontSize: 20, fontWeight: 950, color: THEME.title }}>{value}</div>
      {hint ? <div style={{ marginTop: 6, fontSize: 11, color: THEME.muted }}>{hint}</div> : null}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 900, color: THEME.muted, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

function Th({ children, onClick, active, align }) {
  return (
    <th
      onClick={onClick}
      style={{
        padding: "10px 10px",
        fontSize: 12,
        color: THEME.muted,
        fontWeight: 900,
        cursor: onClick ? "pointer" : "default",
        userSelect: "none",
        textAlign: align || "left",
        whiteSpace: "nowrap",
      }}
      title={onClick ? "Click to sort" : undefined}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {children}
        {active ? <span style={{ fontSize: 11, color: THEME.title }}>●</span> : null}
      </span>
    </th>
  );
}

function Td({ children, align, colSpan }) {
  return (
    <td
      colSpan={colSpan}
      style={{
        padding: "10px 10px",
        fontSize: 13,
        color: THEME.pageText,
        textAlign: align || "left",
        verticalAlign: "top",
      }}
    >
      {children}
    </td>
  );
}

export default function Liabilities() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [countryFilter, setCountryFilter] = useState("ALL");
  const [sortKey, setSortKey] = useState("updatedAt");
  const [sortDir, setSortDir] = useState("desc");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");

    apiFetch("/liabilities")
      .then((res) => {
        if (!alive) return;
        const list = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
        setRows(list.map(normalizeApiRow));
      })
      .catch((e) => alive && setError(e.message || "Failed to load"))
      .finally(() => alive && setLoading(false));

    return () => {
      alive = false;
    };
  }, []);

  const filteredSortedRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = rows;

    if (countryFilter !== "ALL") {
      const want = countryFilter === "India" ? "INDIA" : "USA";
      list = list.filter((r) => String(r.country || "").toUpperCase() === want);
    }

    if (q) {
      list = list.filter((r) => {
        const hay = `${r.category || ""} ${r.country || ""} ${r.description || ""} ${r.remarks || ""}`.toLowerCase();
        return hay.includes(q);
      });
    }

    const dir = sortDir === "asc" ? 1 : -1;

    const getVal = (r) => {
      switch (sortKey) {
        case "country":
          return String(r.country || "");
        case "category":
          return String(r.category || "");
        case "description":
          return String(r.description || "");
        case "remarks":
          return String(r.remarks || "");
        case "value":
          return safeNum(r.value, 0);
        case "updatedAt":
        default:
          return r.updatedAt || r.createdAt || "";
      }
    };

    return [...list].sort((a, b) => {
      const va = getVal(a);
      const vb = getVal(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [rows, search, countryFilter, sortKey, sortDir]);

  const totalLiabilities = useMemo(() => {
    const base =
      countryFilter === "ALL"
        ? rows
        : rows.filter(
            (r) =>
              String(r.country || "").toUpperCase() ===
              (countryFilter === "India" ? "INDIA" : "USA")
          );
    return round2(base.reduce((s, r) => s + safeNum(r.value, 0), 0));
  }, [rows, countryFilter]);

  function resetForm({ hide } = {}) {
    setForm(DEFAULT_FORM);
    setEditingId(null);
    setError("");
    if (hide) setShowForm(false);
  }

  function openCreateForm() {
    setError("");
    setEditingId(null);
    setForm(DEFAULT_FORM);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startEdit(r) {
    setError("");
    setEditingId(r.id);
    const c = String(r.country || "").trim().toUpperCase();
    setForm({
      category: CATEGORY_OPTIONS.includes(r.category) ? r.category : "Other",
      country: c === "INDIA" ? "India" : "USA",
      description: r.description || "",
      remarks: r.remarks || "",
      value: String(r.value ?? ""),
    });
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function buildPayloadFromForm() {
    const category = String(form.category || "").trim();
    const country = String(form.country || "").trim();
    const description = String(form.description || "").trim();
    const remarks = String(form.remarks || "").trim();
    const value = safeNum(form.value, NaN);

    if (!category) throw new Error("Liability Category is required");
    if (!COUNTRY_OPTIONS.includes(country)) throw new Error("Country is required");
    if (!description) throw new Error("Liability Description is required");
    if (!Number.isFinite(value)) throw new Error("Liability Value must be a valid number");

    return {
      category,
      country: country === "India" ? "INDIA" : "USA",
      description,
      remarks,
      value: Number(clamp(value, -1e15, 1e15).toFixed(2)),
    };
  }

  async function refreshList() {
    const res = await apiFetch("/liabilities");
    const list = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
    setRows(list.map(normalizeApiRow));
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setSaving(true);

    try {
      const payload = buildPayloadFromForm();

      if (editingId) {
        const updated = await apiFetch(`/liabilities/${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          body: payload,
        });

        setRows((prev) => prev.map((r) => (r.id === editingId ? normalizeApiRow({ ...r, ...updated }) : r)));
        await refreshList();
        resetForm({ hide: true });
      } else {
        const created = await apiFetch("/liabilities", { method: "POST", body: payload });
        setRows((prev) => [normalizeApiRow(created), ...prev]);
        await refreshList();
        resetForm({ hide: true });
      }
    } catch (err) {
      setError(err.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(id) {
    if (!id) return;
    const ok = window.confirm("Delete this record?");
    if (!ok) return;

    setSaving(true);
    setError("");
    try {
      await apiFetch(`/liabilities/${encodeURIComponent(id)}`, { method: "DELETE" });
      setRows((prev) => prev.filter((r) => r.id !== id));
      await refreshList();
    } catch (e) {
      setError(e.message || "Delete failed");
    } finally {
      setSaving(false);
    }
  }

  function onToggleSort(key) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  return (
    <div style={{ padding: 16, color: THEME.pageText }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 900, color: THEME.title, letterSpacing: "0.2px" }}>
            Liabilities
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(4, minmax(180px, 1fr))", gap: 12 }}>
        <SummaryCard title="Total Liabilities" value={formatMoney(totalLiabilities)} hint="Sum of all listed records" />
      </div>

      {showForm ? (
        <div style={{ ...panel, marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>
              {editingId ? "Edit Liability" : "Add Liability"}
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              {editingId ? (
                <button type="button" onClick={() => resetForm({ hide: true })} style={btnSecondary} disabled={saving}>
                  Cancel
                </button>
              ) : null}
              <button type="button" onClick={() => resetForm({ hide: true })} style={btnSecondary} disabled={saving}>
                Close
              </button>
            </div>
          </div>

          {error ? (
            <div style={{ marginTop: 10, ...callout }}>
              <div style={{ fontWeight: 900, color: THEME.title }}>Error</div>
              <div style={{ marginTop: 4, color: THEME.pageText }}>{error}</div>
            </div>
          ) : null}

          <form onSubmit={onSubmit} style={{ marginTop: 12, display: "grid", gap: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr 1fr", gap: 10 }}>
              <Field label="Liability Category">
                <select
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                  style={input}
                  disabled={saving}
                >
                  {CATEGORY_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Country">
                <select
                  value={form.country}
                  onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
                  style={input}
                  disabled={saving}
                >
                  {COUNTRY_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Liability Description">
                <input
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="e.g., Chase Sapphire balance"
                  style={input}
                  disabled={saving}
                />
              </Field>

              <Field label="Liability Value (USD)">
                <input
                  value={form.value}
                  onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                  placeholder="5000.00"
                  inputMode="decimal"
                  style={input}
                  disabled={saving}
                />
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
              <Field label="Remarks">
                <input
                  value={form.remarks}
                  onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
                  placeholder="Optional notes…"
                  style={input}
                  disabled={saving}
                />
              </Field>
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
              <button type="button" onClick={() => resetForm()} style={btnSecondary} disabled={saving}>
                Reset
              </button>
              <button type="submit" style={{ ...btnPrimary, opacity: saving ? 0.75 : 1 }} disabled={saving}>
                {saving ? "Saving…" : editingId ? "Save Changes" : "Create"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <div style={{ ...panel, marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>All Records</div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={openCreateForm} style={btnPrimary} disabled={saving}>
              Add Liability
            </button>

            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search category/country/description/remarks…"
              style={{ ...input, width: 260 }}
              disabled={loading}
            />

            <select
              value={countryFilter}
              onChange={(e) => setCountryFilter(e.target.value)}
              style={{ ...input, width: 140 }}
              disabled={loading}
            >
              <option value="ALL">All</option>
              <option value="USA">USA</option>
              <option value="India">India</option>
            </select>

            <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} style={{ ...input, width: 170 }}>
              <option value="updatedAt">Sort: Updated</option>
              <option value="category">Sort: Category</option>
              <option value="country">Sort: Country</option>
              <option value="description">Sort: Description</option>
              <option value="remarks">Sort: Remarks</option>
              <option value="value">Sort: Value</option>
            </select>

            <button
              type="button"
              onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
              style={btnSecondary}
              disabled={loading}
            >
              {sortDir === "asc" ? "Asc" : "Desc"}
            </button>
          </div>
        </div>

        {error ? (
          <div style={{ marginTop: 10, ...callout }}>
            <div style={{ fontWeight: 900, color: THEME.title }}>Error</div>
            <div style={{ marginTop: 4, color: THEME.pageText }}>{error}</div>
          </div>
        ) : null}

        <div style={{ marginTop: 10, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <Th onClick={() => onToggleSort("category")} active={sortKey === "category"}>
                  Liability Category
                </Th>
                <Th onClick={() => onToggleSort("country")} active={sortKey === "country"}>
                  Country
                </Th>
                <Th onClick={() => onToggleSort("description")} active={sortKey === "description"}>
                  Liability Description
                </Th>
                <Th onClick={() => onToggleSort("remarks")} active={sortKey === "remarks"}>
                  Remarks
                </Th>
                <Th onClick={() => onToggleSort("value")} active={sortKey === "value"}>
                  Liability Value
                </Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>

            <tbody>
              {filteredSortedRows.map((r) => (
                <tr key={r.id} style={{ borderTop: `1px solid ${THEME.rowBorder}` }}>
                  <Td>
                    <div style={{ fontWeight: 900, color: THEME.title }}>{r.category}</div>
                  </Td>

                  <Td>
                    <div style={{ fontWeight: 900, color: THEME.title }}>
                      {String(r.country || "").toUpperCase() === "INDIA" ? "India" : "USA"}
                    </div>
                  </Td>

                  <Td>
                    <div style={{ fontWeight: 900, color: THEME.title }}>{r.description}</div>
                  </Td>

                  <Td>
                    <div style={{ fontWeight: 800, color: THEME.pageText }}>
                      {r.remarks ? r.remarks : <span style={{ color: THEME.muted }}>—</span>}
                    </div>
                  </Td>

                  <Td>
                    <div style={{ fontWeight: 900, color: THEME.title }}>{formatMoney(r.value)}</div>
                  </Td>

                  <Td align="right">
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingRight: 8 }}>
                      <button type="button" onClick={() => startEdit(r)} style={btnSecondarySmall} disabled={saving}>
                        Edit
                      </button>
                      <button type="button" onClick={() => onDelete(r.id)} style={btnDangerSmall} disabled={saving}>
                        Delete
                      </button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>

            <tfoot>
              <tr style={{ borderTop: `1px solid ${THEME.rowBorder}` }}>
                <Td colSpan={4}>
                  <div style={{ fontWeight: 900, color: THEME.title }}>Total</div>
                </Td>
                <Td>
                  <div style={{ fontWeight: 900, color: THEME.title }}>{formatMoney(totalLiabilities)}</div>
                </Td>
                <Td align="right" />
              </tr>
            </tfoot>
          </table>
        </div>

        {loading ? <div style={{ marginTop: 10, color: THEME.muted, fontSize: 12 }}>Loading…</div> : null}
      </div>
    </div>
  );
}
