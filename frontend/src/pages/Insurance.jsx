import { useEffect, useMemo, useState } from "react";

const COUNTRY_OPTIONS = ["USA", "India"];

const INSURANCE_TYPE_OPTIONS = [
  "Health",
  "Life",
  "Auto",
  "Home",
  "Renters",
  "Travel",
  "Disability",
  "Umbrella",
  "Pet",
  "Other",
];

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

function formatMoney(n) {
  const x = safeNum(n, 0);
  return x.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

/* ---------------- API wiring  ---------------- */
function getApiBase() {
  const envBase = (import.meta.env.VITE_API_BASE_URL || "").trim();
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
    throw new Error(`API returned non-JSON (${res.status}). First chars: ${text.slice(0, 30)}`);
  }

  if (!res.ok) throw new Error(data?.error || data?.message || `Request failed (${res.status})`);
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

/* ---------------- defaults ---------------- */
const DEFAULT_FORM = {
  country: "USA",
  insuranceType: "Health",
  insuranceTypeOther: "",
  provider: "",
  coveredAmount: "",
  remarks: "",
};

export default function Insurance() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [editingId, setEditingId] = useState(null);

  // hide Add card by default (same UX as FixedIncome)
  const [showForm, setShowForm] = useState(false);

  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [countryFilter, setCountryFilter] = useState("ALL");
  const [sortKey, setSortKey] = useState("provider");
  const [sortDir, setSortDir] = useState("asc");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");

    apiFetch("/assets/insurance")
      .then((res) => {
        if (!alive) return;
        const list = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
        setRows(list.map(normalizeApiRow));
      })
      .catch((e) => {
        if (!alive) return;
        setError(e?.message || "Failed to load insurance records");
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

  const summary = useMemo(() => {
    const totalCovered = rows.reduce((acc, r) => acc + safeNum(r.coveredAmount, 0), 0);
    const usaCovered = rows
      .filter((r) => String(r.country || "").toUpperCase() !== "INDIA")
      .reduce((acc, r) => acc + safeNum(r.coveredAmount, 0), 0);
    const indiaCovered = rows
      .filter((r) => String(r.country || "").toUpperCase() === "INDIA")
      .reduce((acc, r) => acc + safeNum(r.coveredAmount, 0), 0);

    return {
      count: rows.length,
      totalCovered,
      usaCovered,
      indiaCovered,
    };
  }, [rows]);

  const filteredSortedRows = useMemo(() => {
    const q = search.trim().toLowerCase();

    let list = rows.filter((r) => {
      if (countryFilter !== "ALL") {
        const isIndia = String(r.country || "").toUpperCase() === "INDIA";
        if (countryFilter === "USA" && isIndia) return false;
        if (countryFilter === "India" && !isIndia) return false;
      }
      if (!q) return true;
      const hay = [
        r.insuranceType,
        r.provider,
        r.remarks,
        String(r.coveredAmount ?? ""),
        String(r.country ?? ""),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });

    const dir = sortDir === "asc" ? 1 : -1;

    list.sort((a, b) => {
      const va = a?.[sortKey];
      const vb = b?.[sortKey];

      if (sortKey === "coveredAmount") return (safeNum(va, 0) - safeNum(vb, 0)) * dir;

      const sa = String(va ?? "").toLowerCase();
      const sb = String(vb ?? "").toLowerCase();
      if (sa < sb) return -1 * dir;
      if (sa > sb) return 1 * dir;
      return 0;
    });

    return list;
  }, [rows, search, countryFilter, sortKey, sortDir]);

  function openCreateForm() {
    setEditingId(null);
    setForm(DEFAULT_FORM);
    setError("");
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
  }

  function resetForm({ hide } = {}) {
    setEditingId(null);
    setForm(DEFAULT_FORM);
    setError("");
    if (hide) setShowForm(false);
  }

  function startEdit(r) {
    setError("");
    setEditingId(r.id);

    const typeIsKnown = INSURANCE_TYPE_OPTIONS.includes(r.insuranceType);
    setForm({
      country: String(r.country || "").toUpperCase() === "INDIA" ? "India" : "USA",
      insuranceType: typeIsKnown ? r.insuranceType : "Other",
      insuranceTypeOther: typeIsKnown ? "" : String(r.insuranceType || ""),
      provider: String(r.provider || ""),
      coveredAmount: r.coveredAmount ?? "",
      remarks: String(r.remarks || ""),
    });
    setShowForm(true);
  }

  function getEffectiveInsuranceType(f) {
    if (f.insuranceType === "Other") return String(f.insuranceTypeOther || "").trim();
    return String(f.insuranceType || "").trim();
  }

  function validateFrontEnd(f) {
    const insuranceType = getEffectiveInsuranceType(f);
    if (!insuranceType) throw new Error("Insurance Type is required");
    const provider = String(f.provider || "").trim();
    if (!provider) throw new Error("Insurance Provider is required");

    const amt = Number(f.coveredAmount);
    if (!Number.isFinite(amt) || amt <= 0) throw new Error("Covered Amount must be a number > 0");
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError("");

    try {
      validateFrontEnd(form);

      setSaving(true);

      const payload = {
        country: form.country,
        insuranceType: getEffectiveInsuranceType(form),
        provider: String(form.provider || "").trim(),
        coveredAmount: Number(form.coveredAmount),
        remarks: String(form.remarks || "").trim(),
      };

      if (editingId) {
        const updated = await apiFetch(`/assets/insurance/${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          body: payload,
        });
        const norm = normalizeApiRow(updated);
        setRows((prev) => prev.map((x) => (x.id === editingId ? norm : x)));
        resetForm({ hide: true });
      } else {
        const created = await apiFetch("/assets/insurance", { method: "POST", body: payload });
        const norm = normalizeApiRow(created);
        setRows((prev) => [norm, ...prev]);
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
    const ok = window.confirm("Delete this insurance record?");
    if (!ok) return;

    try {
      setSaving(true);
      await apiFetch(`/assets/insurance/${encodeURIComponent(id)}`, { method: "DELETE" });
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
      setSortDir("asc");
    }
  }

  const panel = {
    background: THEME.panelBg,
    border: `1px solid ${THEME.panelBorder}`,
    borderRadius: 14,
    padding: 14,
    boxShadow: "0 12px 30px rgba(0,0,0,0.22)",
    backdropFilter: "blur(10px)",
  };

  const input = {
    width: "100%",
    background: THEME.inputBg,
    border: `1px solid ${THEME.inputBorder}`,
    borderRadius: 10,
    padding: "10px 10px",
    color: THEME.title,
    outline: "none",
    fontSize: 13,
  };

  const btnPrimary = {
    background: THEME.primaryBg,
    border: `1px solid ${THEME.primaryBorder}`,
    color: THEME.title,
    fontWeight: 900,
    borderRadius: 10,
    padding: "10px 12px",
    cursor: "pointer",
  };

  const btnSecondary = {
    background: "transparent",
    border: `1px solid ${THEME.inputBorder}`,
    color: THEME.pageText,
    fontWeight: 900,
    borderRadius: 10,
    padding: "10px 12px",
    cursor: "pointer",
  };

  const btnSecondarySmall = { ...btnSecondary, padding: "6px 10px", fontSize: 12 };
  const btnDangerSmall = {
    background: THEME.dangerBg,
    border: `1px solid ${THEME.dangerBorder}`,
    color: THEME.title,
    fontWeight: 900,
    borderRadius: 10,
    padding: "6px 10px",
    cursor: "pointer",
    fontSize: 12,
  };

  const callout = {
    background: "rgba(239, 68, 68, 0.12)",
    border: `1px solid ${THEME.dangerBorder}`,
    borderRadius: 12,
    padding: 12,
  };

  return (
    <div style={{ padding: 16, color: THEME.pageText }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontSize: 22, fontWeight: 900, color: THEME.title, letterSpacing: "0.2px" }}>
          Insurance
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
        <SummaryCard title="Policies" value={String(summary.count)} panel={panel} />
        <SummaryCard title="Total Covered" value={formatMoney(summary.totalCovered)} panel={panel} />
        <SummaryCard title="USA Covered" value={formatMoney(summary.usaCovered)} panel={panel} />
        <SummaryCard title="India Covered" value={formatMoney(summary.indiaCovered)} panel={panel} />
      </div>

      {showForm ? (
        <div style={{ ...panel, marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>
              {editingId ? "Edit Insurance" : "Add Insurance"}
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

              <Field label="Insurance Type">
                <select
                  value={form.insuranceType}
                  onChange={(e) => setForm((f) => ({ ...f, insuranceType: e.target.value }))}
                  style={input}
                  disabled={saving}
                >
                  {INSURANCE_TYPE_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Insurance Provider">
                <input
                  value={form.provider}
                  onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
                  placeholder="e.g., Blue Cross / Geico / LIC"
                  style={input}
                  disabled={saving}
                />
              </Field>

              <Field label="Covered Amount (USD)">
                <input
                  value={form.coveredAmount}
                  onChange={(e) => setForm((f) => ({ ...f, coveredAmount: e.target.value }))}
                  placeholder="250000"
                  inputMode="decimal"
                  style={input}
                  disabled={saving}
                />
              </Field>
            </div>

            {form.insuranceType === "Other" ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
                <Field label="Other Type">
                  <input
                    value={form.insuranceTypeOther}
                    onChange={(e) => setForm((f) => ({ ...f, insuranceTypeOther: e.target.value }))}
                    placeholder="Enter insurance type"
                    style={input}
                    disabled={saving}
                  />
                </Field>
              </div>
            ) : null}

            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
              <Field label="Remarks (optional)">
                <input
                  value={form.remarks}
                  onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
                  placeholder="e.g., Policy #, coverage notes, renewal reminders"
                  style={input}
                  disabled={saving}
                />
              </Field>
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
              <button type="button" onClick={() => setForm(DEFAULT_FORM)} style={btnSecondary} disabled={saving}>
                Reset
              </button>
              <button type="submit" style={{ ...btnPrimary, opacity: saving ? 0.75 : 1 }} disabled={saving}>
                {saving ? "Saving…" : editingId ? "Save Changes" : "Add Record"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* Records table */}
      <div style={{ ...panel, marginTop: 14, paddingBottom: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>All Records</div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={openCreateForm} style={btnPrimary} disabled={saving}>
              Add Insurance Record
            </button>

            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search country/type/provider/remarks…"
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

            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value)}
              style={{ ...input, width: 190 }}
              disabled={loading}
            >
              <option value="provider">Sort: Provider</option>
              <option value="insuranceType">Sort: Type</option>
              <option value="country">Sort: Country</option>
              <option value="coveredAmount">Sort: Covered Amount</option>
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
            No insurance records yet. Click “Add Insurance Record” to create one.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <Th onClick={() => onToggleSort("insuranceType")} active={sortKey === "insuranceType"}>
                    Insurance Type
                  </Th>
                  <Th onClick={() => onToggleSort("provider")} active={sortKey === "provider"}>
                    Provider
                  </Th>
                  <Th onClick={() => onToggleSort("country")} active={sortKey === "country"}>
                    Country
                  </Th>
                  <Th onClick={() => onToggleSort("coveredAmount")} active={sortKey === "coveredAmount"}>
                    Covered Amount
                  </Th>
                  <Th>Remarks</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {filteredSortedRows.map((r) => (
                  <tr key={r.id} style={{ borderTop: `1px solid ${THEME.rowBorder}` }}>
                    <Td>
                      <div style={{ fontWeight: 900, color: THEME.title }}>{r.insuranceType}</div>
                    </Td>
                    <Td>{r.provider}</Td>
                    <Td>{String(r.country || "").toUpperCase() === "INDIA" ? "India" : "USA"}</Td>
                    <Td>
                      <div style={{ fontWeight: 900, color: THEME.title }}>{formatMoney(r.coveredAmount)}</div>
                    </Td>
                    <Td>
                      <div style={{ fontSize: 12, color: THEME.muted, maxWidth: 420, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {r.remarks || "—"}
                      </div>
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
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- small UI components ---------- */

function SummaryCard({ title, value, hint, panel }) {
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
        textAlign: align || "left",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {children}
        {active ? <span style={{ opacity: 0.85 }}>▾</span> : null}
      </span>
    </th>
  );
}

function Td({ children, align }) {
  return (
    <td style={{ padding: "12px 10px", fontSize: 13, textAlign: align || "left", verticalAlign: "top" }}>
      {children}
    </td>
  );
}
