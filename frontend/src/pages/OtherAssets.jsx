import { useEffect, useMemo, useState } from "react";

console.log("VITE_API_BASE_URL =", import.meta.env.VITE_API_BASE_URL);

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

const CATEGORY_OPTIONS = ["Education", "Retirement", "Robo", "Cash", "Options", "Property"];

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function safeNum(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function formatMoney(n) {
  const x = safeNum(n, 0);
  return x.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

/* ---------------- API wiring (same pattern as FixedIncome) ---------------- */
function getApiBase() {
  const envBase = (import.meta?.env?.VITE_API_BASE_URL || "").trim();
  if (envBase) return envBase.replace(/\/+$/, "");

  const winBase = (window?.__FINVAULT_API_BASE_URL || "").trim?.() || "";
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
    throw new Error(
      `API returned non-JSON (${res.status}). First chars: ${text.slice(0, 30)}`
    );
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
    id: item.assetId || item.id,
  };
}

const COUNTRY_OPTIONS = ["USA", "India"];

const DEFAULT_FORM = {
  country: "USA",
  category: "Education",
  description: "",
  value: "",
};

export default function OtherAssets() {
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

    apiFetch("/assets/otherassets")
      .then((res) => {
        if (!alive) return;
        const list = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
        setRows(list.map(normalizeApiRow));
      })
      .catch((e) => {
        if (!alive) return;
        setError(e?.message || "Failed to load other assets");
        setRows([]);
      })
      .finally(() => {
        if (!alive) return;
        setLoading(false);
      });

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
        const hay = `${r.country || ""} ${r.category || ""} ${r.description || ""}`.toLowerCase();
        return hay.includes(q);
      });
    }

    const dir = sortDir === "asc" ? 1 : -1;

    const getVal = (r) => {
      switch (sortKey) {
        case "country":
          return String(r.country || "");
        case "category":
          return r.category || "";
        case "value":
          return safeNum(r.value, 0);
        case "description":
          return r.description || "";
        case "updatedAt":
        default:
          return r.updatedAt || r.createdAt || "";
      }
    };

    list = [...list].sort((a, b) => {
      const va = getVal(a);
      const vb = getVal(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });

    return list;
  }, [rows, search, countryFilter, sortKey, sortDir]);

  const totalValue = useMemo(() => {
    const base = countryFilter === "ALL"
      ? rows
      : rows.filter((r) => String(r.country || "").toUpperCase() === (countryFilter === "India" ? "INDIA" : "USA"));
    return base.reduce((s, r) => s + safeNum(r.value, 0), 0);
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

  function closeForm() {
    resetForm({ hide: true });
  }

  function startEdit(r) {
    setError("");
    setEditingId(r.id);
    const c = String(r.country || "").trim().toUpperCase();
    setForm({
      country: c === "INDIA" ? "India" : "USA",
      category: CATEGORY_OPTIONS.includes(r.category) ? r.category : "Education",
      description: r.description || "",
      value: String(r.value ?? ""),
    });
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function buildPayloadFromForm() {
    const country = String(form.country || "").trim();
    const category = String(form.category || "").trim();
    const description = String(form.description || "").trim();
    const value = safeNum(form.value, NaN);

    if (!country || !COUNTRY_OPTIONS.includes(country)) {
      throw new Error("Country is required");
    }
    if (!category || !CATEGORY_OPTIONS.includes(category)) {
      throw new Error("Asset Category is required");
    }
    if (!description) throw new Error("Asset Description is required");
    if (!Number.isFinite(value)) throw new Error("Asset Value must be a valid number");

    return {
      country: country === "India" ? "INDIA" : "USA",
      category,
      description,
      value: Number(clamp(value, -1e15, 1e15).toFixed(2)),
    };
  }

  async function refreshList() {
    const res = await apiFetch("/assets/otherassets");
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
        const updated = await apiFetch(`/assets/otherassets/${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          body: payload,
        });

        setRows((prev) => prev.map((r) => (r.id === editingId ? normalizeApiRow({ ...r, ...updated }) : r)));
        await refreshList();
        resetForm({ hide: true });
      } else {
        const created = await apiFetch("/assets/otherassets", { method: "POST", body: payload });
        setRows((prev) => [normalizeApiRow(created), ...prev]);
        await refreshList();
        resetForm({ hide: true });
      }
    } catch (err) {
      setError(err?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(id) {
    setError("");
    const ok = window.confirm("Delete this other asset record?");
    if (!ok) return;

    try {
      setSaving(true);
      await apiFetch(`/assets/otherassets/${encodeURIComponent(id)}`, { method: "DELETE" });
      setRows((prev) => prev.filter((r) => r.id !== id));
      if (editingId === id) resetForm({ hide: true });
    } catch (err) {
      setError(err?.message || "Delete failed");
    } finally {
      setSaving(false);
    }
  }

  function onToggleSort(key) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  return (
    <div style={{ padding: 16, color: THEME.pageText }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 900, color: THEME.title, letterSpacing: "0.2px" }}>
            Other Assets
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: 14,
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(180px, 1fr))",
          gap: 12,
        }}
      >
        <SummaryCard title="Total Other Assets" value={formatMoney(totalValue)} hint="Sum of all listed records" />
      </div>

      {showForm ? (
        <div style={{ ...panel, marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>
              {editingId ? "Edit Other Asset" : "Add Other Asset"}
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              {editingId ? (
                <button type="button" onClick={() => resetForm({ hide: true })} style={btnSecondary} disabled={saving}>
                  Cancel
                </button>
              ) : null}

              <button type="button" onClick={closeForm} style={btnSecondary} disabled={saving}>
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
              <Field label="Asset Category">
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

              <Field label="Asset Description">
                <input
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="e.g., Robinhood Cash Sweep"
                  style={input}
                  disabled={saving}
                />
              </Field>

              <Field label="Latest Asset Value (USD)">
                <input
                  value={form.value}
                  onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                  placeholder="1000.00"
                  inputMode="decimal"
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
                {saving ? "Saving…" : editingId ? "Save Changes" : "Add Record"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <div style={{ ...panel, marginTop: 14, paddingBottom: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>All Records</div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={openCreateForm} style={btnPrimary} disabled={saving}>
              Add Other Asset
            </button>

            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search country/category/description…"
              style={{ ...input, width: 240 }}
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

            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value)}
              style={{ ...input, width: 170 }}
              disabled={loading}
            >
              <option value="updatedAt">Sort: Updated</option>
              <option value="country">Sort: Country</option>
              <option value="category">Sort: Category</option>
              <option value="description">Sort: Description</option>
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

        <div style={{ marginTop: 10, borderTop: `1px solid ${THEME.rowBorder}` }} />

        {loading ? (
          <div style={{ padding: 14, color: THEME.muted }}>Loading…</div>
        ) : filteredSortedRows.length === 0 ? (
          <div style={{ padding: 14, color: THEME.muted }}>
            No other assets yet. Click “Add Other Asset” to create one.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <Th onClick={() => onToggleSort("category")} active={sortKey === "category"}>
                    Asset Category
                  </Th>
                  <Th onClick={() => onToggleSort("description")} active={sortKey === "description"}>
                    Asset Description
                  </Th>
                  <Th onClick={() => onToggleSort("country")} active={sortKey === "country"}>
                    Country
                  </Th>
                  <Th onClick={() => onToggleSort("value")} active={sortKey === "value"}>
                    Latest Asset Value
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
                      <div style={{ fontWeight: 900, color: THEME.title }}>{r.description}</div>
                    </Td>
                    <Td>
                      <div style={{ fontWeight: 900, color: THEME.title }}>
                        {String(r.country || "").toUpperCase() === "INDIA" ? "India" : "USA"}
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
                    <div style={{ fontWeight: 900, color: THEME.title }}>{formatMoney(totalValue)}</div>
                  </Td>
                  <Td align="right" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- small UI components (copied style) ---------- */

function SummaryCard({ title, value, hint }) {
  return (
    <div style={panel}>
      <div style={{ fontSize: 12, color: THEME.muted, fontWeight: 800 }}>{title}</div>
      <div style={{ marginTop: 6, fontSize: 18, fontWeight: 900, color: THEME.title }}>{value}</div>
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

function Th({ children, align, onClick, active }) {
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
        whiteSpace: "nowrap",
        ...(active ? { color: THEME.pageText } : null),
      }}
      align={align || "left"}
      title={onClick ? "Click to sort" : undefined}
    >
      {children}
    </th>
  );
}

function Td({ children, align, colSpan }) {
  return (
    <td style={{ padding: "12px 10px", verticalAlign: "top" }} align={align || "left"} colSpan={colSpan}>
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
