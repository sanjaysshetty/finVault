import { useEffect, useMemo, useState } from "react";
console.log("VITE_API_BASE_URL =", import.meta.env.VITE_API_BASE_URL);

const LS_KEY = "finvault.fixedIncome.v1"; // kept for reference only (no longer used for persistence)

const COUNTRY_OPTIONS = ["USA", "India"];

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

function addMonths(dateISO, months) {
  const d = new Date(dateISO);
  const m = Number(months || 0);
  const originalDay = d.getDate();
  d.setMonth(d.getMonth() + m);
  if (d.getDate() !== originalDay) d.setDate(0);
  return d.toISOString().slice(0, 10);
}

function yearsBetween(startISO, endISO) {
  const start = new Date(startISO);
  const end = new Date(endISO);
  const ms = end - start;
  const days = ms / (1000 * 60 * 60 * 24);
  return Math.max(0, days / 365.25);
}

function freqToN(freq) {
  switch ((freq || "YEARLY").toUpperCase()) {
    case "DAILY":
      return 365;
    case "MONTHLY":
      return 12;
    case "QUARTERLY":
      return 4;
    case "YEARLY":
    default:
      return 1;
  }
}

function computeValue({
  principal,
  annualRate,
  startDate,
  asOfDate,
  interestType,
  compoundFrequency,
}) {
  const P = safeNum(principal, 0);
  const r = safeNum(annualRate, 0);
  if (!startDate) return { value: P, interest: 0 };

  const t = yearsBetween(startDate, asOfDate);
  const type = (interestType || "SIMPLE").toUpperCase();

  let value = P;
  if (type === "COMPOUND") {
    const n = freqToN(compoundFrequency);
    value = P * Math.pow(1 + r / n, n * t);
  } else {
    value = P * (1 + r * t);
  }

  const interest = value - P;
  return { value, interest };
}

const DEFAULT_FORM = {
  country: "USA",
  name: "",
  principal: "",
  annualRatePct: "",
  startDate: todayISO(),
  termMonths: 12,
  interestType: "COMPOUND",
  compoundFrequency: "MONTHLY",
  notes: "",
};

/* ---------------- API wiring ---------------- */
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

function buildApiUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  const base = getApiBase();
  return new URL(p, base || window.location.origin);
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

/* ---------------- Component ---------------- */

export default function FixedIncome() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [editingId, setEditingId] = useState(null);

  // ✅ NEW: hide Add card by default
  const [showForm, setShowForm] = useState(false);

  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [countryFilter, setCountryFilter] = useState("ALL");
  const [sortKey, setSortKey] = useState("startDate");
  const [sortDir, setSortDir] = useState("desc");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");

    apiFetch("/assets/fixedincome")
      .then((res) => {
        if (!alive) return;
        const list = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
        setRows(list.map(normalizeApiRow));
      })
      .catch((e) => {
        if (!alive) return;
        setError(e?.message || "Failed to load fixed income records");
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

  const asOfDate = todayISO();

  const enrichedRows = useMemo(() => {
    return rows.map((r) => {
      const hasBackend =
        Number.isFinite(Number(r.currentValue)) &&
        Number.isFinite(Number(r.interestEarnedToDate));

      if (hasBackend) {
        return {
          ...r,
          currentValue: Number(Number(r.currentValue).toFixed(2)),
          interestEarnedToDate: Number(Number(r.interestEarnedToDate).toFixed(2)),
        };
      }

      const calc = computeValue({
        principal: r.principal,
        annualRate: r.annualRate,
        startDate: r.startDate,
        asOfDate,
        interestType: r.interestType,
        compoundFrequency: r.compoundFrequency,
      });

      return {
        ...r,
        currentValue: Number(calc.value.toFixed(2)),
        interestEarnedToDate: Number(calc.interest.toFixed(2)),
      };
    });
  }, [rows, asOfDate]);

  const filteredSortedRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = enrichedRows;

    if (countryFilter !== "ALL") {
      const want = countryFilter === "India" ? "INDIA" : "USA";
      list = list.filter((r) => String(r.country || "").toUpperCase() === want);
    }

    if (q) {
      list = list.filter((r) => {
        const hay = `${r.country || ""} ${r.name || ""} ${r.notes || ""}`.toLowerCase();
        return hay.includes(q);
      });
    }

    const dir = sortDir === "asc" ? 1 : -1;

    const getVal = (r) => {
      switch (sortKey) {
        case "country":
          return String(r.country || "");
        case "principal":
          return safeNum(r.principal, 0);
        case "currentValue":
          return safeNum(r.currentValue, 0);
        case "maturityDate":
          return r.maturityDate || "";
        case "startDate":
        default:
          return r.startDate || "";
      }
    };

    list = [...list].sort((a, b) => {
      const va = getVal(a);
      const vb = getVal(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });

    return list;
  }, [enrichedRows, search, countryFilter, sortKey, sortDir]);

  const summary = useMemo(() => {
    const base = countryFilter === "ALL"
      ? enrichedRows
      : enrichedRows.filter((r) => String(r.country || "").toUpperCase() === (countryFilter === "India" ? "INDIA" : "USA"));
    const invested = base.reduce((s, r) => s + safeNum(r.principal, 0), 0);
    const current = base.reduce((s, r) => s + safeNum(r.currentValue, 0), 0);
    const interest = base.reduce((s, r) => s + safeNum(r.interestEarnedToDate, 0), 0);
    const maturity = base.reduce((s, r) => s + safeNum(r.maturityAmount, 0), 0);
    return { invested, current, interest, maturity };
  }, [enrichedRows, countryFilter]);

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
      name: r.name || "",
      principal: String(r.principal ?? ""),
      annualRatePct: String(((safeNum(r.annualRate, 0) * 100) || 0).toFixed(4)).replace(
        /\.?0+$/,
        ""
      ),
      startDate: r.startDate || todayISO(),
      termMonths: r.termMonths ?? 12,
      interestType: r.interestType || "SIMPLE",
      compoundFrequency: r.compoundFrequency || "YEARLY",
      notes: r.notes || "",
    });

    // ✅ ensure the card is visible when editing
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function buildPayloadFromForm() {
    const country = String(form.country || "").trim();
    const principal = safeNum(form.principal, NaN);
    const annualRatePct = safeNum(form.annualRatePct, NaN);

    if (!country || !COUNTRY_OPTIONS.includes(country)) throw new Error("Country is required");
    if (!form.name.trim()) throw new Error("Name is required");
    if (!form.startDate) throw new Error("Start date is required");
    if (!Number.isFinite(principal) || principal <= 0)
      throw new Error("Principal must be a positive number");
    if (!Number.isFinite(annualRatePct) || annualRatePct < 0)
      throw new Error("Annual rate must be valid (percent)");
    const termMonths = clamp(parseInt(form.termMonths, 10) || 0, 1, 600);

    const annualRate = annualRatePct / 100;

    return {
      country: country === "India" ? "INDIA" : "USA",
      name: form.name.trim(),
      principal: Number(principal.toFixed(2)),
      annualRate: Number(annualRate.toFixed(8)),
      interestType: form.interestType,
      compoundFrequency: form.compoundFrequency,
      startDate: form.startDate,
      termMonths,
      notes: form.notes?.trim() || "",
    };
  }

  async function refreshList({ keepEditing = false } = {}) {
    const res = await apiFetch("/assets/fixedincome");
    const list = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
    setRows(list.map(normalizeApiRow));
    if (!keepEditing) setEditingId(null);
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setSaving(true);

    try {
      const payload = buildPayloadFromForm();

      if (editingId) {
        const updated = await apiFetch(`/assets/fixedincome/${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          body: payload,
        });

        setRows((prev) =>
          prev.map((r) => (r.id === editingId ? normalizeApiRow({ ...r, ...updated }) : r))
        );
        await refreshList({ keepEditing: false });
        resetForm({ hide: true });
      } else {
        const created = await apiFetch("/assets/fixedincome", { method: "POST", body: payload });
        setRows((prev) => [normalizeApiRow(created), ...prev]);
        await refreshList({ keepEditing: false });
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
    const ok = window.confirm("Delete this fixed income record?");
    if (!ok) return;

    try {
      setSaving(true);
      await apiFetch(`/assets/fixedincome/${encodeURIComponent(id)}`, { method: "DELETE" });
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
            Fixed Income
          </div>
        </div>
        <div style={{ fontSize: 12, color: THEME.muted, textAlign: "right" }}>
          As of <span style={{ color: THEME.pageText, fontWeight: 700 }}>{asOfDate}</span>
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
        <SummaryCard title="Invested Amount" value={formatMoney(summary.invested)} />
        <SummaryCard title="Current Value" value={formatMoney(summary.current)} hint="Computed at runtime" />
        <SummaryCard title="Interest Earned" value={formatMoney(summary.interest)} hint="To date" />
        <SummaryCard title="Maturity Amount" value={formatMoney(summary.maturity)} hint="Stored on create/update" />
      </div>

      {/* ✅ Form card is now hidden by default */}
      {showForm ? (
        <div style={{ ...panel, marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>
              {editingId ? "Edit Fixed Income" : "Add Fixed Income"}
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

          {loading ? (
            <div style={{ marginTop: 10, color: THEME.muted, fontSize: 13 }}>Loading records…</div>
          ) : null}

          <form onSubmit={onSubmit} style={{ marginTop: 12, display: "grid", gap: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 10 }}>
              <Field label="Name">
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g., CD - Chase 12M"
                  style={input}
                  disabled={saving}
                />
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
              <Field label="Principal (USD)">
                <input
                  value={form.principal}
                  onChange={(e) => setForm((f) => ({ ...f, principal: e.target.value }))}
                  placeholder="10000"
                  inputMode="decimal"
                  style={input}
                  disabled={saving}
                />
              </Field>
              <Field label="Annual Rate (%)">
                <input
                  value={form.annualRatePct}
                  onChange={(e) => setForm((f) => ({ ...f, annualRatePct: e.target.value }))}
                  placeholder="5.25"
                  inputMode="decimal"
                  style={input}
                  disabled={saving}
                />
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
              <Field label="Start Date">
                <input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                  style={input}
                  disabled={saving}
                />
              </Field>
              <Field label="Term (Months)">
                <input
                  value={form.termMonths}
                  onChange={(e) => setForm((f) => ({ ...f, termMonths: e.target.value }))}
                  inputMode="numeric"
                  style={input}
                  disabled={saving}
                />
              </Field>
              <Field label="Interest Type">
                <select
                  value={form.interestType}
                  onChange={(e) => setForm((f) => ({ ...f, interestType: e.target.value }))}
                  style={input}
                  disabled={saving}
                >
                  <option value="SIMPLE">Simple</option>
                  <option value="COMPOUND">Compound</option>
                </select>
              </Field>
              <Field label="Compound Frequency">
                <select
                  value={form.compoundFrequency}
                  onChange={(e) => setForm((f) => ({ ...f, compoundFrequency: e.target.value }))}
                  style={{ ...input, opacity: form.interestType === "COMPOUND" ? 1 : 0.5 }}
                  disabled={saving || form.interestType !== "COMPOUND"}
                >
                  <option value="YEARLY">Yearly</option>
                  <option value="QUARTERLY">Quarterly</option>
                  <option value="MONTHLY">Monthly</option>
                  <option value="DAILY">Daily</option>
                </select>
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: 10 }}>
              <Field label="Notes (optional)">
                <input
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="e.g., auto-renew off"
                  style={input}
                  disabled={saving}
                />
              </Field>

              <div style={{ ...miniPanel }}>
                <div style={{ fontSize: 12, color: THEME.muted, fontWeight: 800 }}>Preview</div>
                <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
                  <MiniRow
                    label="Maturity Date"
                    value={
                      form.startDate
                        ? addMonths(form.startDate, clamp(parseInt(form.termMonths, 10) || 0, 1, 600))
                        : "-"
                    }
                  />
                  <MiniRow
                    label="Stored Maturity"
                    value={() => {
                      const principal = safeNum(form.principal, NaN);
                      const rate = safeNum(form.annualRatePct, NaN) / 100;
                      const termMonths = clamp(parseInt(form.termMonths, 10) || 0, 1, 600);
                      if (!Number.isFinite(principal) || !Number.isFinite(rate) || !form.startDate) return "-";
                      const maturityDate = addMonths(form.startDate, termMonths);
                      const calc = computeValue({
                        principal,
                        annualRate: rate,
                        startDate: form.startDate,
                        asOfDate: maturityDate,
                        interestType: form.interestType,
                        compoundFrequency: form.compoundFrequency,
                      });
                      return formatMoney(calc.value);
                    }}
                  />
                </div>
              </div>
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

      {/* Records table */}
      <div style={{ ...panel, marginTop: 14, paddingBottom: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>All Records</div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={openCreateForm}
              style={btnPrimary}
              disabled={saving}
            >
              Add Fixed Income Record
            </button>

            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search country/name/notes…"
              style={{ ...input, width: 220 }}
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
              <option value="startDate">Sort: Start Date</option>
              <option value="country">Sort: Country</option>
              <option value="maturityDate">Sort: Maturity Date</option>
              <option value="principal">Sort: Principal</option>
              <option value="currentValue">Sort: Current Value</option>
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
            No fixed income records yet. Click “Add Fixed Income Record” to create one.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <Th onClick={() => onToggleSort("startDate")} active={sortKey === "startDate"}>
                    Name
                  </Th>
                  <Th onClick={() => onToggleSort("country")} active={sortKey === "country"}>
                    Country
                  </Th>
                  <Th onClick={() => onToggleSort("principal")} active={sortKey === "principal"}>
                    Principal
                  </Th>
                  <Th>Rate</Th>
                  <Th>Start</Th>
                  <Th onClick={() => onToggleSort("maturityDate")} active={sortKey === "maturityDate"}>
                    Maturity
                  </Th>
                  <Th onClick={() => onToggleSort("currentValue")} active={sortKey === "currentValue"}>
                    Current Value
                  </Th>
                  <Th>Stored Maturity</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {filteredSortedRows.map((r) => (
                  <tr key={r.id} style={{ borderTop: `1px solid ${THEME.rowBorder}` }}>
                    <Td>
                      <div style={{ fontWeight: 900, color: THEME.title }}>{r.name}</div>
                      {r.notes ? (
                        <div style={{ marginTop: 3, fontSize: 12, color: THEME.muted }}>{r.notes}</div>
                      ) : null}
                      <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <Pill text={r.interestType === "COMPOUND" ? `Compound · ${r.compoundFrequency}` : "Simple"} />
                        <Pill text={`${r.termMonths} months`} />
                      </div>
                    </Td>
                    <Td>
                      {String(r.country || "").toUpperCase() === "INDIA" ? "India" : "USA"}
                    </Td>
                    <Td>{formatMoney(r.principal)}</Td>
                    <Td>{(safeNum(r.annualRate, 0) * 100).toFixed(2)}%</Td>
                    <Td>{r.startDate}</Td>
                    <Td>{r.maturityDate}</Td>
                    <Td>
                      <div style={{ fontWeight: 900, color: THEME.title }}>{formatMoney(r.currentValue)}</div>
                      <div style={{ fontSize: 12, color: THEME.muted }}>
                        Interest: {formatMoney(r.interestEarnedToDate)}
                      </div>
                    </Td>
                    <Td>{formatMoney(r.maturityAmount)}</Td>
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

function Pill({ text }) {
  return (
    <span
      style={{
        fontSize: 11,
        color: THEME.pageText,
        border: `1px solid ${THEME.panelBorder}`,
        background: "rgba(148, 163, 184, 0.06)",
        padding: "3px 8px",
        borderRadius: 999,
        fontWeight: 800,
      }}
    >
      {text}
    </span>
  );
}

function MiniRow({ label, value }) {
  const v = typeof value === "function" ? value() : value;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
      <div style={{ color: THEME.muted, fontSize: 12, fontWeight: 800 }}>{label}</div>
      <div style={{ color: THEME.pageText, fontSize: 12, fontWeight: 900 }}>{v}</div>
    </div>
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

const miniPanel = {
  background: "rgba(2, 6, 23, 0.28)",
  border: `1px solid ${THEME.panelBorder}`,
  borderRadius: 12,
  padding: 12,
  height: "100%",
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
