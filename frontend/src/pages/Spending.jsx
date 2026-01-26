import { useEffect, useMemo, useRef, useState } from "react";

function getApiBase() {
  const envBase = (import.meta?.env?.VITE_API_BASE_URL || "").trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const winBase = (window?.__FINVAULT_API_BASE_URL || "").trim?.() || "";
  if (winBase) return winBase.replace(/\/+$/, "");
  if (import.meta.env.DEV) {
    console.error("VITE_API_BASE_URL is missing. Requests will hit localhost and return HTML.");
  }
  return ""; // allow relative as fallback (prod may proxy)
}

function getAccessToken() {
  return (
    sessionStorage.getItem("finvault.accessToken") ||
    sessionStorage.getItem("access_token") ||
    sessionStorage.getItem("token") ||
    ""
  );
}

function authHeaders(extra = {}) {
  const t = getAccessToken();
  return {
    ...extra,
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
  };
}

const API_BASE = getApiBase();

// ✅ NEW: safe URL builder (works with API_BASE="" too)
function apiUrl(path) {
  // ensure path starts with "/"
  const p = path.startsWith("/") ? path : `/${path}`;
  // If API_BASE is set, use it. Otherwise use current origin (prevents Invalid URL).
  const base = API_BASE || window.location.origin;
  return new URL(p, base);
}

function fmtUSD(x) {
  const n = typeof x === "string" ? Number(x) : x;
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

function toNumberOrNull(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

function normalizeDateInput(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.slice(0, 10);
}

async function fetchAllSpending({ limitPerPage = 200, maxPages = 80 }) {
  let items = [];
  let nextToken = null;
  let pages = 0;

  do {
    const url = apiUrl("/spending");
    url.searchParams.set("limit", String(limitPerPage));
    if (nextToken) url.searchParams.set("nextToken", nextToken);

    const resp = await fetch(url.toString(), {
      cache: "no-store",
      headers: authHeaders(),
    });
    if (!resp.ok) throw new Error(`API ${resp.status} (spending list)`);
    const json = await resp.json();

    items = items.concat(json.items || []);
    nextToken = json.nextToken || null;
    pages += 1;
  } while (nextToken && pages < maxPages);

  return items;
}

function groupByReceipt(items) {
  const map = new Map();
  for (const it of items) {
    const receipt = it.receipt || (it.pk ? String(it.pk).replace("RECEIPT#", "") : "UNKNOWN");
    if (!map.has(receipt)) map.set(receipt, []);
    map.get(receipt).push(it);
  }

  const groups = Array.from(map.entries()).map(([receipt, rows]) => {
    const maxDate =
      rows
        .map((r) => r.date)
        .filter(Boolean)
        .sort()
        .slice(-1)[0] || "";
    return { receipt, rows, maxDate };
  });

  groups.sort((a, b) => (b.maxDate || "").localeCompare(a.maxDate || ""));
  return groups;
}

// --- Header calc helpers ---
function normDesc(x) {
  return String(x ?? "").trim().toUpperCase();
}

function isBlankLineItem(row) {
  const desc = String(row.productDescription ?? "").trim();
  const code = String(row.productCode ?? "").trim();
  const amt = row.amount;
  const nAmt = typeof amt === "number" ? amt : Number(amt);
  const hasAmt = Number.isFinite(nAmt);
  return !desc && !code && !hasAmt;
}

function isSummaryRow(row) {
  const d = normDesc(row.productDescription);
  return d === "SUBTOTAL" || d === "TAX" || d === "TOTAL" || normDesc(row.category) === "SUMMARY";
}

function isSubtotalOrTotal(row) {
  const d = normDesc(row.productDescription);
  return d === "SUBTOTAL" || d === "TOTAL";
}

function isTax(row) {
  return normDesc(row.productDescription) === "TAX";
}

function isCountableItem(row) {
  if (isBlankLineItem(row)) return false;
  if (isSummaryRow(row)) return false;
  return true;
}

function isIncludedInDollarTotal(row) {
  if (isBlankLineItem(row)) return false;
  if (isSubtotalOrTotal(row)) return false;
  if (isTax(row)) return true;
  if (normDesc(row.category) === "SUMMARY") return false;
  return true;
}

function shouldDisplayRow(row) {
  const code = String(row?.productCode ?? "").trim();
  const desc = String(row?.productDescription ?? "").trim();
  return code.length > 0 || desc.length > 0;
}

// -------------------- Upload helpers --------------------

function sanitizeFilename(name) {
  return String(name || "upload")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

async function getPresignedUploadUrl({ filename, contentType }) {
  const url = apiUrl("/receipts/upload-url");
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ filename, contentType }),
  });
  if (!resp.ok) throw new Error(`Failed to get upload URL (${resp.status})`);
  return resp.json();
}

async function uploadToS3WithPresignedUrl({ fileOrBlob, filename, contentType }) {
  const { uploadUrl, key } = await getPresignedUploadUrl({ filename, contentType });

  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: fileOrBlob,
  });

  if (!put.ok) throw new Error(`S3 upload failed (${put.status})`);
  return { key };
}

function blobToJpegFromVideo(videoEl, { quality = 0.85, maxWidth = 1400 } = {}) {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  if (!w || !h) throw new Error("Camera not ready yet.");

  const scale = w > maxWidth ? maxWidth / w : 1;
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, cw, ch);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
  });
}

function safeDomId(str) {
  return `date_${String(str).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

// -------------------- Component --------------------

export default function Spending() {
  const [raw, setRaw] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const [q, setQ] = useState("");
  const [open, setOpen] = useState(() => new Set());
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState({});
  const [deleting, setDeleting] = useState({});

  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");
  const fileInputRef = useRef(null);

  const [scanOpen, setScanOpen] = useState(false);
  const [scanErr, setScanErr] = useState("");
  const videoRef = useRef(null);
  const streamRef = useRef(null);

  async function load() {
    setLoading(true);
    setErr("");
    try {
      const items = await fetchAllSpending({ limitPerPage: 200, maxPages: 80 });
      setRaw(items);

      const groups = groupByReceipt(items);
      if (groups.length) setOpen(new Set([groups[0].receipt]));
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function toggleReceipt(receipt) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(receipt)) next.delete(receipt);
      else next.add(receipt);
      return next;
    });
  }

  function rowKeyFromPkSk(row) {
    return `${row.pk}::${row.sk}`;
  }

  function setEdit(key, field, value) {
    setEdits((prev) => ({
      ...prev,
      [key]: { ...(prev[key] || {}), [field]: value },
    }));
  }

  function mergedValue(item, key, field) {
    if (edits[key] && field in edits[key]) return edits[key][field];
    if (field === "date") return item.date ?? "";
    if (field === "productDescription") return item.productDescription ?? "";
    if (field === "category") return item.category ?? "";
    if (field === "amount") return item.amount ?? "";
    return "";
  }

  function hasEdits(key) {
    const e = edits[key];
    if (!e) return false;
    return "date" in e || "productDescription" in e || "category" in e || "amount" in e;
  }

  async function readErrorText(resp) {
    const text = await resp.text().catch(() => "");
    try {
      const j = JSON.parse(text);
      return j?.error ? `${j.error}` : text;
    } catch {
      return text;
    }
  }

  async function saveRow(row) {
    const pk = row.pk;
    const sk = row.sk;
    if (!pk || !sk) {
      setErr("Cannot save: missing pk/sk on this row.");
      return;
    }

    const key = rowKeyFromPkSk(row);
    const patch = edits[key];
    if (!patch || !hasEdits(key)) return;

    setSaving((p) => ({ ...p, [key]: true }));
    setErr("");

    try {
      const url = apiUrl(`/spending/item/${encodeURIComponent(pk)}/${encodeURIComponent(sk)}`);

      const body = {
        date: patch.date !== undefined ? normalizeDateInput(patch.date) : undefined,
        productDescription:
          patch.productDescription !== undefined ? String(patch.productDescription) : undefined,
        category: patch.category !== undefined ? String(patch.category) : undefined,
        amount: patch.amount !== undefined ? toNumberOrNull(patch.amount) : undefined,
      };
      Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

      const resp = await fetch(url.toString(), {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const msg = await readErrorText(resp);
        throw new Error(`PATCH failed: ${resp.status} ${msg}`.trim());
      }

      const json = await resp.json();
      const updated = json.item;

      setRaw((prev) => prev.map((r) => (r.pk === pk && r.sk === sk ? updated : r)));

      setEdits((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving((p) => ({ ...p, [key]: false }));
    }
  }

  async function deleteRow(row) {
    const pk = row.pk;
    const sk = row.sk;
    if (!pk || !sk) {
      setErr("Cannot delete: missing pk/sk on this row.");
      return;
    }

    const key = rowKeyFromPkSk(row);
    if (!confirm(`Delete item ${sk} from ${pk}?`)) return;

    setDeleting((p) => ({ ...p, [key]: true }));
    setErr("");

    try {
      const url = apiUrl(`/spending/item/${encodeURIComponent(pk)}/${encodeURIComponent(sk)}`);
      const resp = await fetch(url.toString(), { method: "DELETE", headers: authHeaders() });

      if (!resp.ok) {
        const msg = await readErrorText(resp);
        throw new Error(`DELETE failed: ${resp.status} ${msg}`.trim());
      }

      setRaw((prev) => prev.filter((r) => !(r.pk === pk && r.sk === sk)));

      setEdits((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (e) {
      setErr(String(e));
    } finally {
      setDeleting((p) => ({ ...p, [key]: false }));
    }
  }

  const groups = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return groupByReceipt(raw);

    const filtered = raw.filter((r) => {
      const desc = String(r.productDescription || "").toLowerCase();
      return desc.includes(query);
    });

    return groupByReceipt(filtered);
  }, [raw, q]);

  async function handleUploadFiles(files) {
    if (!files || files.length === 0) return;

    setUploading(true);
    setUploadMsg("");
    setErr("");

    try {
      for (const file of files) {
        const contentType = file.type || "application/octet-stream";

        const ok =
          contentType === "application/pdf" ||
          contentType.startsWith("image/") ||
          /\.(pdf|png|jpg|jpeg|webp)$/i.test(file.name);

        if (!ok) throw new Error(`Unsupported file type: ${file.name}`);

        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const clean = sanitizeFilename(file.name);
        const filename = `${ts}-${clean}`;

        setUploadMsg(`Uploading ${file.name}…`);

        await uploadToS3WithPresignedUrl({
          fileOrBlob: file,
          filename,
          contentType,
        });
      }

      setUploadMsg("Uploaded. Processing receipt... (refresh in a moment).");
      setTimeout(() => load(), 2500);
    } catch (e) {
      setErr(String(e));
      setUploadMsg("");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function openScanner() {
    setScanErr("");
    setUploadMsg("");
    setErr("");
    setScanOpen(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch {
      setScanErr("Could not access camera. Check permissions or upload instead.");
    }
  }

  function closeScanner() {
    setScanOpen(false);
    setScanErr("");
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
  }

  async function captureAndUpload() {
    if (!videoRef.current) return;

    setUploading(true);
    setUploadMsg("");
    setErr("");
    setScanErr("");

    try {
      setUploadMsg("Capturing image…");
      const jpegBlob = await blobToJpegFromVideo(videoRef.current, {
        quality: 0.85,
        maxWidth: 1400,
      });

      if (!jpegBlob) throw new Error("Failed to create JPG from camera capture.");

      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${ts}-scan.jpg`;

      setUploadMsg("Uploading scan…");
      await uploadToS3WithPresignedUrl({
        fileOrBlob: jpegBlob,
        filename,
        contentType: "image/jpeg",
      });

      setUploadMsg("Uploaded. Processing Receipt... (refresh in a moment).");
      closeScanner();
      setTimeout(() => load(), 2500);
    } catch (e) {
      setErr(String(e));
      setUploadMsg("");
    } finally {
      setUploading(false);
    }
  }

  function openDatePickerById(id) {
    const el = document.getElementById(id);
    if (!el) return;
    try {
      el.focus();
      if (typeof el.showPicker === "function") el.showPicker();
      else el.click();
    } catch {
      el.focus();
    }
  }

  return (
    <div style={{ maxWidth: 1120, margin: "0 auto", padding: "20px 16px" }}>
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          marginBottom: 14,
        }}
      >
        {/* Custom date icon (reliable), hide native indicator */}
        <style>{`
          input.spend-date{
            width:100%;
            box-sizing:border-box;
            background:#0B1220 !important;
            color:#F9FAFB !important;
            border:1px solid #334155 !important;
            border-radius:10px;
            padding:8px 44px 8px 10px; /* room for icon */
            outline:none;
          }

          /* Hide native calendar icon (it’s unreliable across themes) */
          input.spend-date::-webkit-calendar-picker-indicator{
            opacity: 0 !important;
            cursor: pointer;
          }

          .date-wrap{
            position: relative;
            width: 100%;
            min-width: 0;
          }

          .date-btn{
            position:absolute;
            right:10px;
            top:50%;
            transform: translateY(-50%);
            width:28px;
            height:28px;
            border-radius:8px;
            border:1px solid rgba(255,255,255,0.12);
            background: rgba(255,255,255,0.06);
            display:flex;
            align-items:center;
            justify-content:center;
            cursor:pointer;
            padding:0;
          }

          .date-btn:hover{
            background: rgba(255,255,255,0.10);
            border-color: rgba(255,255,255,0.18);
          }

          .date-btn svg{
            width:16px;
            height:16px;
            fill: none;
            stroke: #F9FAFB;
            stroke-width: 2;
            opacity: 0.95;
          }

          input.spend-text{
            width: 100%;
            min-width: 0;
            box-sizing: border-box;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
        `}</style>

        <div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#F9FAFB" }}>Spending</div>
          <div style={{ marginTop: 4, fontSize: 12, color: "#CBD5F5" }}>
            Upload/Scan Store Receipts
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search product description…"
            style={{
              width: 280,
              background: "#0B1220",
              border: "1px solid #334155",
              color: "#F9FAFB",
              padding: "10px 12px",
              borderRadius: 12,
              outline: "none",
            }}
          />

          <button onClick={openScanner} disabled={uploading} style={btn(uploading)}>
            Scan
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            multiple
            onChange={(e) => handleUploadFiles(Array.from(e.target.files || []))}
            style={{ display: "none" }}
            id="receipt-file-input"
          />
          <button
            onClick={() => document.getElementById("receipt-file-input")?.click()}
            disabled={uploading}
            style={btn(uploading)}
          >
            Upload
          </button>

          <button onClick={load} style={btn(false)}>
            Refresh
          </button>
        </div>
      </div>

      {(uploadMsg || uploading) && (
        <div
          style={{
            marginBottom: 10,
            padding: 12,
            borderRadius: 12,
            border: "1px solid #334155",
            background: "#0B1220",
            color: "#E5E7EB",
            fontSize: 13,
          }}
        >
          {uploading ? "Working…" : uploadMsg}
        </div>
      )}

      {scanOpen && (
        <div
          style={{
            border: "1px solid #334155",
            borderRadius: 14,
            background: "#0F172A",
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
            <div style={{ fontWeight: 800, color: "#F9FAFB" }}>Scan receipt</div>
            <button onClick={closeScanner} style={btn(false)}>Close</button>
          </div>

          {scanErr && (
            <div style={{ marginTop: 10, color: "#FCA5A5", fontSize: 13 }}>
              {scanErr}
            </div>
          )}

          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            <video
              ref={videoRef}
              playsInline
              style={{
                width: "100%",
                maxHeight: 420,
                borderRadius: 12,
                border: "1px solid #334155",
                background: "#0B1220",
              }}
            />
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={captureAndUpload} disabled={uploading} style={btn(uploading)}>
                Capture & Upload (JPG)
              </button>
              <div style={{ fontSize: 12, color: "#CBD5F5", alignSelf: "center" }}>
                Tip: hold steady, fill the frame, good lighting.
              </div>
            </div>
          </div>
        </div>
      )}

      {loading && <div style={{ color: "#CBD5F5" }}>Loading…</div>}

      {err && (
        <div
          style={{
            marginTop: 10,
            padding: 12,
            borderRadius: 12,
            border: "1px solid #475569",
            background: "#0B1220",
            color: "#FCA5A5",
            fontSize: 13,
            whiteSpace: "pre-wrap",
          }}
        >
          {err}
        </div>
      )}

      {!loading && !err && groups.length === 0 && (
        <div style={{ color: "#CBD5F5" }}>No receipts match your search.</div>
      )}

      {!loading && groups.length > 0 && (
        <div style={{ display: "grid", gap: 10 }}>
          {groups.map((g) => {
            const isOpen = open.has(g.receipt);

            const totalItems = g.rows.filter(isCountableItem).length;
            const totalDollars = g.rows.reduce((sum, r) => {
              if (!isIncludedInDollarTotal(r)) return sum;
              const n = Number(r.amount);
              return sum + (Number.isFinite(n) ? n : 0);
            }, 0);

            return (
              <div
                key={g.receipt}
                style={{
                  border: "1px solid #334155",
                  borderRadius: 14,
                  background: "#0F172A",
                  overflow: "hidden",
                }}
              >
                <div
                  onClick={() => toggleReceipt(g.receipt)}
                  style={{
                    cursor: "pointer",
                    padding: "12px 14px",
                    display: "grid",
                    gridTemplateColumns: "1fr auto auto",
                    alignItems: "center",
                    columnGap: 14,
                    rowGap: 6,
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 900,
                        color: "#F9FAFB",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={g.receipt}
                    >
                      {g.receipt}
                    </div>

                    <div style={{ marginTop: 2, fontSize: 12, color: "#CBD5F5" }}>
                      <span className="numeric" style={{ fontWeight: 800, color: "#E5E7EB" }}>
                        {totalItems}
                      </span>{" "}
                      items · Total{" "}
                      <span className="numeric" style={{ fontWeight: 900, color: "#FFFFFF" }}>
                        {fmtUSD(totalDollars)}
                      </span>
                    </div>
                  </div>

                  <div
                    className="numeric"
                    style={{
                      justifySelf: "end",
                      fontWeight: 800,
                      color: "#E5E7EB",
                      opacity: g.maxDate ? 1 : 0.8,
                    }}
                    title="Receipt Date"
                  >
                    {g.maxDate || "—"}
                  </div>

                  <div
                    style={{
                      justifySelf: "end",
                      color: "#CBD5F5",
                      fontWeight: 900,
                      paddingLeft: 6,
                    }}
                    aria-label={isOpen ? "Collapse receipt" : "Expand receipt"}
                  >
                    {isOpen ? "–" : "+"}
                  </div>
                </div>

                {isOpen && (
                  <div style={{ borderTop: "1px solid #334155", padding: 12 }}>
                    <div style={{ overflowX: "auto" }}>
                      <table
                        style={{
                          width: "100%",
                          borderCollapse: "collapse",
                          fontSize: 13,
                          tableLayout: "fixed",
                        }}
                      >
                        <colgroup>
                          <col style={{ width: 150 }} />
                          <col style={{ width: 120 }} />
                          <col style={{ width: 150 }} />
                          <col style={{ width: 150 }} />
                          <col style={{ width: 120 }} />
                          <col style={{ width: 140 }} />
                        </colgroup>

                        <thead>
                          <tr style={{ color: "#E5E7EB" }}>
                            <th align="left" style={th}>Date</th>
                            <th align="left" style={th}>Code</th>
                            <th align="left" style={th}>Description</th>
                            <th align="left" style={th}>Category</th>
                            <th align="right" style={th}>Amount</th>
                            <th align="right" style={th}>Actions</th>
                          </tr>
                        </thead>

                        <tbody>
                          {g.rows
                            .filter(shouldDisplayRow)
                            .slice()
                            .sort((a, b) => String(a.sk || "").localeCompare(String(b.sk || "")))
                            .map((row) => {
                              const rowKey = `${row.pk}::${row.sk}`;
                              const dateId = safeDomId(rowKey);

                              const dateVal = normalizeDateInput(mergedValue(row, rowKey, "date"));
                              const desc = mergedValue(row, rowKey, "productDescription");
                              const cat = mergedValue(row, rowKey, "category");
                              const amt = mergedValue(row, rowKey, "amount");

                              return (
                                <tr key={row.sk} style={{ borderTop: "1px solid #334155" }}>
                                  <td style={{ ...td, overflow: "hidden" }}>
                                    <div className="date-wrap">
                                      <input
                                        id={dateId}
                                        className="spend-date"
                                        type="date"
                                        value={dateVal}
                                        onChange={(e) => setEdit(rowKey, "date", e.target.value)}
                                        style={dateInput()}
                                      />
                                      <button
                                        type="button"
                                        className="date-btn"
                                        onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          openDatePickerById(dateId);
                                        }}
                                        aria-label="Pick date"
                                      >
                                        <svg viewBox="0 0 24 24" aria-hidden="true">
                                          <path d="M8 3v3M16 3v3M4 8h16M6 6h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" />
                                        </svg>
                                      </button>
                                    </div>
                                  </td>

                                  <td style={{ ...td, overflow: "hidden", color: "#F9FAFB", fontWeight: 700 }}>
                                    {row.productCode || "—"}
                                  </td>

                                  <td style={{ ...td, overflow: "hidden" }}>
                                    <input
                                      className="spend-text"
                                      value={desc}
                                      onChange={(e) => setEdit(rowKey, "productDescription", e.target.value)}
                                      style={input()}
                                    />
                                  </td>

                                  <td style={{ ...td, overflow: "hidden" }}>
                                    <input
                                      className="spend-text"
                                      value={cat}
                                      onChange={(e) => setEdit(rowKey, "category", e.target.value)}
                                      style={input()}
                                    />
                                  </td>

                                  <td style={{ ...td, textAlign: "right", overflow: "hidden" }}>
                                    <input
                                      className="numeric"
                                      value={amt}
                                      onChange={(e) => setEdit(rowKey, "amount", e.target.value)}
                                      style={{ ...input(), textAlign: "right" }}
                                    />
                                  </td>

                                  <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                                    <button
                                      onClick={() => saveRow(row)}
                                      disabled={!hasEdits(rowKey) || saving[rowKey]}
                                      style={btnSmall(!hasEdits(rowKey) || saving[rowKey])}
                                    >
                                      {saving[rowKey] ? "Saving…" : "Save"}
                                    </button>

                                    <button
                                      onClick={() => deleteRow(row)}
                                      disabled={deleting[rowKey]}
                                      style={btnDanger(deleting[rowKey])}
                                    >
                                      {deleting[rowKey] ? "Deleting…" : "Delete"}
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>

                    <div style={{ marginTop: 10, fontSize: 12, color: "#CBD5F5" }}>
                      Search filters receipts by{" "}
                      <span style={{ color: "#FFFFFF", fontWeight: 800 }}>Product Description</span>.
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* Styles */
const th = { padding: "10px 8px", fontWeight: 800, fontSize: 12, opacity: 0.95 };
const td = { padding: "10px 8px", verticalAlign: "top" };

function input() {
  return {
    width: "100%",
    background: "#0B1220",
    border: "1px solid #334155",
    color: "#F9FAFB",
    padding: "8px 10px",
    borderRadius: 10,
    outline: "none",
    minWidth: 0,
    boxSizing: "border-box",
  };
}

function btn(disabled) {
  return {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid #334155",
    background: disabled ? "#0B1220" : "#0F172A",
    color: disabled ? "#94A3B8" : "#F9FAFB",
    fontWeight: 800,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function btnSmall(disabled) {
  return {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #334155",
    background: disabled ? "#0B1220" : "#0F172A",
    color: disabled ? "#94A3B8" : "#F9FAFB",
    fontWeight: 900,
    cursor: disabled ? "not-allowed" : "pointer",
    marginRight: 8,
  };
}

function btnDanger(disabled) {
  return {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #7F1D1D",
    background: disabled ? "#0B1220" : "#1F0B10",
    color: disabled ? "#94A3B8" : "#FCA5A5",
    fontWeight: 900,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function dateInput() {
  return {
    ...input(),
    minWidth: 0,
    width: "100%",
    boxSizing: "border-box",
  };
}
