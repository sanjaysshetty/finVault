import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../api/client.js";
import { EmptyState } from "../components/ui/EmptyState.jsx";

function fmtUSD(x) {
  const n = typeof x === "string" ? Number(x) : x;
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
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

/* ---------- Paginated fetch ---------- */

async function fetchAllSpending({ limitPerPage = 200, maxPages = 80 }) {
  let items = [];
  let nextToken = null;
  let pages = 0;
  do {
    const qs = new URLSearchParams({ limit: String(limitPerPage) });
    if (nextToken) qs.set("nextToken", nextToken);
    const json = await apiFetch(`/spending?${qs}`);
    items = items.concat(json.items || []);
    nextToken = json.nextToken || null;
    pages += 1;
  } while (nextToken && pages < maxPages);
  return items;
}

/* ---------- S3 upload helpers ---------- */

function sanitizeFilename(name) {
  return String(name || "upload").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

async function getPresignedUploadUrl({ filename, contentType }) {
  return apiFetch("/receipts/upload-url", {
    method: "POST",
    body: { filename, contentType },
  });
}

async function uploadToS3WithPresignedUrl({ fileOrBlob, filename, contentType }) {
  const { uploadUrl, key } = await getPresignedUploadUrl({ filename, contentType });
  // S3 presigned PUT — no auth header needed
  const put = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: fileOrBlob });
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
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, cw, ch);
  return new Promise((resolve) => { canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality); });
}

/* ---------- Row helpers ---------- */

function groupByReceipt(items) {
  const map = new Map();
  for (const it of items) {
    const receipt = it.receipt || (it.pk ? String(it.pk).replace("RECEIPT#", "") : "UNKNOWN");
    if (!map.has(receipt)) map.set(receipt, []);
    map.get(receipt).push(it);
  }
  const groups = Array.from(map.entries()).map(([receipt, rows]) => {
    const maxDate = rows.map((r) => r.date).filter(Boolean).sort().slice(-1)[0] || "";
    return { receipt, rows, maxDate };
  });
  groups.sort((a, b) => (b.maxDate || "").localeCompare(a.maxDate || ""));
  return groups;
}

function normDesc(x) { return String(x ?? "").trim().toUpperCase(); }
function isBlankLineItem(row) {
  const desc = String(row.productDescription ?? "").trim();
  const code = String(row.productCode ?? "").trim();
  const amt = row.amount;
  const nAmt = typeof amt === "number" ? amt : Number(amt);
  return !desc && !code && !Number.isFinite(nAmt);
}
function isSummaryRow(row) {
  const d = normDesc(row.productDescription);
  return d === "SUBTOTAL" || d === "TAX" || d === "TOTAL" || normDesc(row.category) === "SUMMARY";
}
function isSubtotalOrTotal(row) {
  const d = normDesc(row.productDescription);
  return d === "SUBTOTAL" || d === "TOTAL";
}
function isTax(row) { return normDesc(row.productDescription) === "TAX"; }
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
function safeDomId(str) { return `date_${String(str).replace(/[^a-zA-Z0-9_-]/g, "_")}`; }

/* ================================================================
   COMPONENT
================================================================ */

export default function Spending() {
  const [raw, setRaw] = useState([]);
  const [err, setErr] = useState("");
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
  const hasSetInitialOpen = useRef(false);

  const queryClient = useQueryClient();

  /* ---------- Data query (paginated) ---------- */

  const { data: queryData, isLoading: loading, isFetching, refetch } = useQuery({
    queryKey: ["spending", "all"],
    queryFn: () => fetchAllSpending({ limitPerPage: 200, maxPages: 80 }),
    staleTime: 60_000,
  });

  // Populate raw from query data; set initial open receipt only once
  useEffect(() => {
    if (queryData) {
      setRaw(queryData);
      if (!hasSetInitialOpen.current) {
        hasSetInitialOpen.current = true;
        const groups = groupByReceipt(queryData);
        if (groups.length) setOpen(new Set([groups[0].receipt]));
      }
    }
  }, [queryData]);

  /* ---------- Row actions (local state mutations) ---------- */

  function toggleReceipt(receipt) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(receipt)) next.delete(receipt); else next.add(receipt);
      return next;
    });
  }
  function rowKeyFromPkSk(row) { return `${row.pk}::${row.sk}`; }
  function setEdit(key, field, value) { setEdits((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), [field]: value } })); }
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

  async function saveRow(row) {
    const pk = row.pk; const sk = row.sk;
    if (!pk || !sk) { setErr("Cannot save: missing pk/sk on this row."); return; }
    const key = rowKeyFromPkSk(row);
    const patch = edits[key];
    if (!patch || !hasEdits(key)) return;
    setSaving((p) => ({ ...p, [key]: true })); setErr("");
    try {
      const body = {
        date: patch.date !== undefined ? normalizeDateInput(patch.date) : undefined,
        productDescription: patch.productDescription !== undefined ? String(patch.productDescription) : undefined,
        category: patch.category !== undefined ? String(patch.category) : undefined,
        amount: patch.amount !== undefined ? toNumberOrNull(patch.amount) : undefined,
      };
      Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
      const json = await apiFetch(
        `/spending/item/${encodeURIComponent(pk)}/${encodeURIComponent(sk)}`,
        { method: "PATCH", body }
      );
      const updated = json.item;
      setRaw((prev) => prev.map((r) => (r.pk === pk && r.sk === sk ? updated : r)));
      setEdits((prev) => { const next = { ...prev }; delete next[key]; return next; });
    } catch (e) { setErr(e?.message || String(e)); }
    finally { setSaving((p) => ({ ...p, [key]: false })); }
  }

  async function deleteRow(row) {
    const pk = row.pk; const sk = row.sk;
    if (!pk || !sk) { setErr("Cannot delete: missing pk/sk on this row."); return; }
    const key = rowKeyFromPkSk(row);
    if (!confirm(`Delete item ${sk} from ${pk}?`)) return;
    setDeleting((p) => ({ ...p, [key]: true })); setErr("");
    try {
      await apiFetch(
        `/spending/item/${encodeURIComponent(pk)}/${encodeURIComponent(sk)}`,
        { method: "DELETE" }
      );
      setRaw((prev) => prev.filter((r) => !(r.pk === pk && r.sk === sk)));
      setEdits((prev) => { const next = { ...prev }; delete next[key]; return next; });
    } catch (e) { setErr(e?.message || String(e)); }
    finally { setDeleting((p) => ({ ...p, [key]: false })); }
  }

  /* ---------- Derived groups ---------- */

  const groups = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return groupByReceipt(raw);
    const filtered = raw.filter((r) => String(r.productDescription || "").toLowerCase().includes(query));
    return groupByReceipt(filtered);
  }, [raw, q]);

  /* ---------- Upload ---------- */

  async function handleUploadFiles(files) {
    if (!files || files.length === 0) return;
    setUploading(true); setUploadMsg(""); setErr("");
    try {
      for (const file of files) {
        const contentType = file.type || "application/octet-stream";
        const ok = contentType === "application/pdf" || contentType.startsWith("image/") || /\.(pdf|png|jpg|jpeg|webp)$/i.test(file.name);
        if (!ok) throw new Error(`Unsupported file type: ${file.name}`);
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `${ts}-${sanitizeFilename(file.name)}`;
        setUploadMsg(`Uploading ${file.name}…`);
        await uploadToS3WithPresignedUrl({ fileOrBlob: file, filename, contentType });
      }
      setUploadMsg("Uploaded. Processing receipt... (refresh in a moment).");
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["spending", "all"] }), 2500);
    } catch (e) { setErr(String(e)); setUploadMsg(""); }
    finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = ""; }
  }

  async function openScanner() {
    setScanErr(""); setUploadMsg(""); setErr(""); setScanOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
    } catch { setScanErr("Could not access camera. Check permissions or upload instead."); }
  }
  function closeScanner() {
    setScanOpen(false); setScanErr("");
    if (streamRef.current) { for (const t of streamRef.current.getTracks()) t.stop(); streamRef.current = null; }
  }
  async function captureAndUpload() {
    if (!videoRef.current) return;
    setUploading(true); setUploadMsg(""); setErr(""); setScanErr("");
    try {
      setUploadMsg("Capturing image…");
      const jpegBlob = await blobToJpegFromVideo(videoRef.current, { quality: 0.85, maxWidth: 1400 });
      if (!jpegBlob) throw new Error("Failed to create JPG from camera capture.");
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      setUploadMsg("Uploading scan…");
      await uploadToS3WithPresignedUrl({ fileOrBlob: jpegBlob, filename: `${ts}-scan.jpg`, contentType: "image/jpeg" });
      setUploadMsg("Uploaded. Processing Receipt... (refresh in a moment).");
      closeScanner();
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["spending", "all"] }), 2500);
    } catch (e) { setErr(String(e)); setUploadMsg(""); }
    finally { setUploading(false); }
  }
  function openDatePickerById(id) {
    const el = document.getElementById(id);
    if (!el) return;
    try { el.focus(); if (typeof el.showPicker === "function") el.showPicker(); else el.click(); } catch { el.focus(); }
  }

  return (
    <div className="max-w-[1120px] mx-auto px-4 py-5">
      {/* Date picker custom styles (pseudo-selectors can't be Tailwind) */}
      <style>{`
        input.spend-date {
          width: 100%; box-sizing: border-box;
          background: #080D1A !important; color: #F9FAFB !important;
          border: 1px solid rgba(255,255,255,0.08) !important;
          border-radius: 10px; padding: 8px 44px 8px 10px; outline: none;
        }
        input.spend-date::-webkit-calendar-picker-indicator { opacity: 0 !important; cursor: pointer; }
        .date-wrap { position: relative; width: 100%; min-width: 0; }
        .date-btn {
          position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
          width: 28px; height: 28px; border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06);
          display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0;
        }
        .date-btn:hover { background: rgba(255,255,255,0.10); border-color: rgba(255,255,255,0.18); }
        .date-btn svg { width: 16px; height: 16px; fill: none; stroke: #F9FAFB; stroke-width: 2; opacity: 0.95; }
        input.spend-text { width: 100%; min-width: 0; box-sizing: border-box; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      `}</style>

      {/* Header */}
      <div className="flex gap-3 items-center justify-between flex-wrap mb-4">
        <div>
          <h1 className="text-xl font-black text-slate-100">Spending</h1>
          <p className="mt-1 text-xs text-slate-400">Upload/Scan Store Receipts</p>
        </div>
        <div className="flex gap-2.5 items-center flex-wrap">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search product description…"
            className="w-64 bg-[#080D1A] border border-white/[0.08] text-slate-200 px-3 py-2.5 rounded-xl text-sm outline-none focus:border-blue-500/[0.4] transition-colors"
          />
          <button onClick={openScanner} disabled={uploading} className={btnCls(uploading)}>Scan</button>
          <input ref={fileInputRef} type="file" accept="image/*,application/pdf" multiple onChange={(e) => handleUploadFiles(Array.from(e.target.files || []))} className="hidden" id="receipt-file-input" />
          <button onClick={() => document.getElementById("receipt-file-input")?.click()} disabled={uploading} className={btnCls(uploading)}>Upload</button>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className={btnCls(isFetching)}
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {(uploadMsg || uploading) && (
        <div className="mb-3 rounded-xl border border-white/[0.08] bg-[#080D1A] px-3 py-2.5 text-sm text-slate-300">
          {uploading ? "Working…" : uploadMsg}
        </div>
      )}

      {scanOpen && (
        <div className="rounded-2xl border border-white/[0.08] bg-[#0F1729] p-3 mb-3">
          <div className="flex justify-between gap-2.5 items-center mb-2">
            <span className="font-black text-slate-100">Scan receipt</span>
            <button onClick={closeScanner} className={btnCls(false)}>Close</button>
          </div>
          {scanErr && <p className="mt-2 text-sm text-red-300">{scanErr}</p>}
          <div className="mt-2.5 grid gap-2.5">
            <video ref={videoRef} playsInline className="w-full max-h-[420px] rounded-xl border border-white/[0.08] bg-[#080D1A]" />
            <div className="flex gap-2.5 flex-wrap items-center">
              <button onClick={captureAndUpload} disabled={uploading} className={btnCls(uploading)}>Capture & Upload (JPG)</button>
              <span className="text-xs text-slate-400">Tip: hold steady, fill the frame, good lighting.</span>
            </div>
          </div>
        </div>
      )}

      {loading && <EmptyState type="loading" message="Loading receipts…" />}

      {err && (
        <div className="mt-2.5 rounded-xl border border-white/[0.08] bg-[#080D1A] px-3 py-2.5 text-sm text-red-300 whitespace-pre-wrap">
          {err}
        </div>
      )}

      {!loading && !err && groups.length === 0 && (
        <EmptyState type="empty" message="No receipts match your search." />
      )}

      {!loading && groups.length > 0 && (
        <div className="grid gap-2.5">
          {groups.map((g) => {
            const isOpen = open.has(g.receipt);
            const totalItems = g.rows.filter(isCountableItem).length;
            const totalDollars = g.rows.reduce((sum, r) => {
              if (!isIncludedInDollarTotal(r)) return sum;
              const n = Number(r.amount);
              return sum + (Number.isFinite(n) ? n : 0);
            }, 0);

            return (
              <div key={g.receipt} className="rounded-2xl border border-white/[0.08] bg-[#0F1729] overflow-hidden">
                <div
                  onClick={() => toggleReceipt(g.receipt)}
                  className="cursor-pointer px-4 py-3 grid items-center gap-3.5"
                  style={{ gridTemplateColumns: "1fr auto auto" }}
                >
                  <div className="flex flex-col min-w-0">
                    <span className="font-black text-slate-100 truncate" title={g.receipt}>{g.receipt}</span>
                    <span className="mt-0.5 text-xs text-slate-400">
                      <span className="font-bold text-slate-200">{totalItems}</span> items · Total{" "}
                      <span className="font-black text-white">{fmtUSD(totalDollars)}</span>
                    </span>
                  </div>
                  <span className="font-bold text-slate-300 text-sm justify-self-end" title="Receipt Date">{g.maxDate || "—"}</span>
                  <span className="font-black text-slate-400 justify-self-end pl-1.5" aria-label={isOpen ? "Collapse" : "Expand"}>{isOpen ? "–" : "+"}</span>
                </div>

                {isOpen && (
                  <div className="border-t border-white/[0.06] p-3">
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-sm" style={{ tableLayout: "fixed" }}>
                        <colgroup>
                          <col style={{ width: 150 }} />
                          <col style={{ width: 120 }} />
                          <col style={{ width: 150 }} />
                          <col style={{ width: 150 }} />
                          <col style={{ width: 120 }} />
                          <col style={{ width: 140 }} />
                        </colgroup>
                        <thead>
                          <tr className="text-slate-400">
                            {["Date", "Code", "Description", "Category", "Amount", "Actions"].map((h, i) => (
                              <th key={h} className={`px-2 py-2.5 text-xs font-bold uppercase tracking-widest ${i >= 4 ? "text-right" : "text-left"}`}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {g.rows.filter(shouldDisplayRow).slice().sort((a, b) => String(a.sk || "").localeCompare(String(b.sk || ""))).map((row) => {
                            const rowKey = `${row.pk}::${row.sk}`;
                            const dateId = safeDomId(rowKey);
                            const dateVal = normalizeDateInput(mergedValue(row, rowKey, "date"));
                            const desc = mergedValue(row, rowKey, "productDescription");
                            const cat = mergedValue(row, rowKey, "category");
                            const amt = mergedValue(row, rowKey, "amount");

                            return (
                              <tr key={row.sk} className="border-t border-white/[0.06]">
                                <td className="px-2 py-2.5 align-top overflow-hidden">
                                  <div className="date-wrap">
                                    <input id={dateId} className="spend-date" type="date" value={dateVal} onChange={(e) => setEdit(rowKey, "date", e.target.value)} />
                                    <button type="button" className="date-btn" onClick={(e) => { e.preventDefault(); e.stopPropagation(); openDatePickerById(dateId); }} aria-label="Pick date">
                                      <svg viewBox="0 0 24 24" aria-hidden="true">
                                        <path d="M8 3v3M16 3v3M4 8h16M6 6h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" />
                                      </svg>
                                    </button>
                                  </div>
                                </td>
                                <td className="px-2 py-2.5 align-top overflow-hidden text-slate-100 font-bold">{row.productCode || "—"}</td>
                                <td className="px-2 py-2.5 align-top overflow-hidden">
                                  <input className="spend-text" value={desc} onChange={(e) => setEdit(rowKey, "productDescription", e.target.value)} style={inlineInput} />
                                </td>
                                <td className="px-2 py-2.5 align-top overflow-hidden">
                                  <input className="spend-text" value={cat} onChange={(e) => setEdit(rowKey, "category", e.target.value)} style={inlineInput} />
                                </td>
                                <td className="px-2 py-2.5 align-top text-right overflow-hidden">
                                  <input value={amt} onChange={(e) => setEdit(rowKey, "amount", e.target.value)} style={{ ...inlineInput, textAlign: "right" }} />
                                </td>
                                <td className="px-2 py-2.5 align-top text-right whitespace-nowrap">
                                  <button onClick={() => saveRow(row)} disabled={!hasEdits(rowKey) || saving[rowKey]} className={saveBtnCls(!hasEdits(rowKey) || saving[rowKey])}>
                                    {saving[rowKey] ? "Saving…" : "Save"}
                                  </button>
                                  <button onClick={() => deleteRow(row)} disabled={deleting[rowKey]} className={delBtnCls(deleting[rowKey])}>
                                    {deleting[rowKey] ? "Deleting…" : "Delete"}
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-2.5 text-xs text-slate-500">
                      Search filters receipts by <span className="text-slate-200 font-bold">Product Description</span>.
                    </p>
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

/* ---------- style helpers ---------- */

const inlineInput = {
  width: "100%", background: "#080D1A", border: "1px solid rgba(255,255,255,0.08)",
  color: "#F9FAFB", padding: "8px 10px", borderRadius: 10, outline: "none",
  minWidth: 0, boxSizing: "border-box",
};

function btnCls(disabled) {
  return [
    "px-3.5 py-2 rounded-xl border text-sm font-bold transition-colors",
    disabled
      ? "border-white/[0.05] bg-[#080D1A] text-slate-600 cursor-not-allowed"
      : "border-white/[0.08] bg-[#0F1729] text-slate-200 hover:bg-white/[0.06] cursor-pointer",
  ].join(" ");
}
function saveBtnCls(disabled) {
  return [
    "mr-2 px-2.5 py-1.5 rounded-lg border text-xs font-bold transition-colors",
    disabled
      ? "border-white/[0.05] bg-[#080D1A] text-slate-600 cursor-not-allowed"
      : "border-white/[0.08] bg-white/[0.04] text-slate-200 hover:bg-white/[0.08] cursor-pointer",
  ].join(" ");
}
function delBtnCls(disabled) {
  return [
    "px-2.5 py-1.5 rounded-lg border text-xs font-bold transition-colors",
    disabled
      ? "border-white/[0.05] bg-[#080D1A] text-slate-600 cursor-not-allowed"
      : "border-red-900/[0.5] bg-red-950/[0.5] text-red-300 hover:bg-red-900/[0.3] cursor-pointer",
  ].join(" ");
}
