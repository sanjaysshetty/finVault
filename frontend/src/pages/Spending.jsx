import { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE;

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

async function fetchAllSpending({ limitPerPage = 200, maxPages = 80, signal }) {
  let items = [];
  let nextToken = null;
  let pages = 0;

  do {
    const url = new URL(`${API_BASE}/spending`);
    url.searchParams.set("limit", String(limitPerPage));
    if (nextToken) url.searchParams.set("nextToken", nextToken);

    const resp = await fetch(url.toString(), { cache: "no-store", signal });
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
    const receipt =
      it.receipt || (it.pk ? String(it.pk).replace("RECEIPT#", "") : "UNKNOWN");
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
    return { receipt, tells: receipt, rows, maxDate };
  });

  groups.sort((a, b) => (b.maxDate || "").localeCompare(a.maxDate || ""));
  return groups;
}

function parseReceiptAndLine(item) {
  const receipt =
    item.receipt || (item.pk ? String(item.pk).replace("RECEIPT#", "") : "");
  const lineId = item.lineId;
  return { receipt, lineId };
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
  if (isSummaryRow(row)) return false; // excludes SUBTOTAL/TAX/TOTAL
  return true;
}

function isIncludedInDollarTotal(row) {
  if (isBlankLineItem(row)) return false;
  if (isSubtotalOrTotal(row)) return false; // exclude SUBTOTAL + TOTAL
  if (isTax(row)) return true; // include TAX
  if (normDesc(row.category) === "SUMMARY") return false; // defensive
  return true;
}

// -------------------- NEW: Upload helpers --------------------

function sanitizeFilename(name) {
  return String(name || "upload")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

async function getPresignedUploadUrl({ filename, contentType }) {
  const resp = await fetch(`${API_BASE}/receipts/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, contentType }),
  });
  if (!resp.ok) throw new Error(`Failed to get upload URL (${resp.status})`);
  return resp.json(); // { uploadUrl, key }
}

async function uploadToS3WithPresignedUrl({ fileOrBlob, filename, contentType }) {
  const { uploadUrl, key } = await getPresignedUploadUrl({ filename, contentType });

  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
    },
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
    canvas.toBlob(
      (blob) => resolve(blob),
      "image/jpeg",
      quality
    );
  });
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

  // NEW: upload UI state
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");
  const fileInputRef = useRef(null);

  // NEW: scan UI state
  const [scanOpen, setScanOpen] = useState(false);
  const [scanErr, setScanErr] = useState("");
  const videoRef = useRef(null);
  const streamRef = useRef(null);

  async function load() {
    setLoading(true);
    setErr("");
    try {
      const controller = new AbortController();
      const items = await fetchAllSpending({
        limitPerPage: 200,
        maxPages: 80,
        signal: controller.signal,
      });
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

  function setEdit(key, field, value) {
    setEdits((prev) => ({
      ...prev,
      [key]: { ...(prev[key] || {}), [field]: value },
    }));
  }

  function mergedValue(item, key, field) {
    if (edits[key] && field in edits[key]) return edits[key][field];
    if (field === "productDescription") return item.productDescription ?? "";
    if (field === "category") return item.category ?? "";
    if (field === "amount") return item.amount ?? "";
    return "";
  }

  function hasEdits(key) {
    const e = edits[key];
    if (!e) return false;
    return "productDescription" in e || "category" in e || "amount" in e;
  }

  async function saveRow(item) {
    const { receipt, lineId } = parseReceiptAndLine(item);
    const key = `${receipt}::${lineId}`;
    const patch = edits[key];
    if (!patch || !hasEdits(key)) return;

    setSaving((p) => ({ ...p, [key]: true }));
    setErr("");

    try {
      const url = `${API_BASE}/spending/receipt/${encodeURIComponent(
        receipt
      )}/line/${encodeURIComponent(String(lineId))}`;

      const body = {
        productDescription:
          patch.productDescription !== undefined
            ? String(patch.productDescription)
            : undefined,
        category:
          patch.category !== undefined ? String(patch.category) : undefined,
        amount:
          patch.amount !== undefined ? toNumberOrNull(patch.amount) : undefined,
      };
      Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

      const resp = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!resp.ok) throw new Error(`PATCH failed: ${resp.status}`);
      const json = await resp.json();
      const updated = json.item;

      setRaw((prev) =>
        prev.map((r) => (r.pk === updated.pk && r.sk === updated.sk ? updated : r))
      );

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

  async function deleteRow(item) {
    const { receipt, lineId } = parseReceiptAndLine(item);
    const key = `${receipt}::${lineId}`;

    if (!confirm(`Delete line ${lineId} from receipt ${receipt}?`)) return;

    setDeleting((p) => ({ ...p, [key]: true }));
    setErr("");

    try {
      const url = `${API_BASE}/spending/receipt/${encodeURIComponent(
        receipt
      )}/line/${encodeURIComponent(String(lineId))}`;

      const resp = await fetch(url, { method: "DELETE" });
      if (!resp.ok) throw new Error(`DELETE failed: ${resp.status}`);

      setRaw((prev) =>
        prev.filter((r) => !(r.pk === item.pk && r.sk === item.sk))
      );

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

  // Search filters receipts by productDescription match (same behavior)
  const groups = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return groupByReceipt(raw);

    const filtered = raw.filter((r) => {
      const desc = String(r.productDescription || "").toLowerCase();
      return desc.includes(query);
    });

    return groupByReceipt(filtered);
  }, [raw, q]);

  // -------------------- NEW: Upload handlers --------------------

  async function handleUploadFiles(files) {
    if (!files || files.length === 0) return;

    setUploading(true);
    setUploadMsg("");
    setErr("");

    try {
      // Upload sequentially for simplicity (keeps UX predictable)
      for (const file of files) {
        const contentType = file.type || "application/octet-stream";

        // Accept pdf + images
        const ok =
          contentType === "application/pdf" ||
          contentType.startsWith("image/") ||
          /\.(pdf|png|jpg|jpeg|webp)$/i.test(file.name);

        if (!ok) {
          throw new Error(`Unsupported file type: ${file.name}`);
        }

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

      setUploadMsg("Uploaded. Lambda will process it shortly (refresh in a moment).");
      // Optional: auto-refresh after a short delay
      setTimeout(() => load(), 2500);
    } catch (e) {
      setErr(String(e));
      setUploadMsg("");
    } finally {
      setUploading(false);
      // reset file input so same file can be selected again
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // -------------------- NEW: Scan (camera) handlers --------------------

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
    } catch (e) {
      setScanErr(
        "Could not access camera. Check browser permissions or try uploading a file instead."
      );
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

      setUploadMsg("Uploaded. Lambda will process it shortly (refresh in a moment).");
      closeScanner();
      setTimeout(() => load(), 2500);
    } catch (e) {
      setErr(String(e));
      setUploadMsg("");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "20px 16px" }}>
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
        <div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>Spending</div>
          <div style={{ marginTop: 4, fontSize: 12, color: "#9CA3AF" }}>
            Upload/Scan receipts → S3 → Lambda → DynamoDB · Search by Product Description · Edit Description / Category / Amount
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search product description…"
            style={{
              width: 260,
              background: "#0B1220",
              border: "1px solid #1F2937",
              color: "#F9FAFB",
              padding: "10px 12px",
              borderRadius: 12,
              outline: "none",
            }}
          />

          {/* NEW: Scan */}
          <button onClick={openScanner} disabled={uploading} style={btn(uploading)}>
            Scan
          </button>

          {/* NEW: Upload */}
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
            border: "1px solid #1F2937",
            background: "#0B1220",
            color: "#9CA3AF",
            fontSize: 13,
          }}
        >
          {uploading ? "Working…" : uploadMsg}
          {uploadMsg && <div style={{ marginTop: 6 }}>{uploadMsg}</div>}
        </div>
      )}

      {scanOpen && (
        <div
          style={{
            border: "1px solid #1F2937",
            borderRadius: 14,
            background: "#0F172A",
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
            <div style={{ fontWeight: 800 }}>Scan receipt</div>
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
                border: "1px solid #1F2937",
                background: "#0B1220",
              }}
            />
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={captureAndUpload} disabled={uploading} style={btn(uploading)}>
                Capture & Upload (JPG)
              </button>
              <div style={{ fontSize: 12, color: "#9CA3AF", alignSelf: "center" }}>
                Tip: hold steady, fill the frame, good lighting.
              </div>
            </div>
          </div>
        </div>
      )}

      {loading && <div style={{ color: "#9CA3AF" }}>Loading…</div>}

      {err && (
        <div
          style={{
            marginTop: 10,
            padding: 12,
            borderRadius: 12,
            border: "1px solid #374151",
            background: "#0B1220",
            color: "#FCA5A5",
            fontSize: 13,
          }}
        >
          {err}
        </div>
      )}

      {!loading && !err && groups.length === 0 && (
        <div style={{ color: "#9CA3AF" }}>No receipts match your search.</div>
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
                  border: "1px solid #1F2937",
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
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <div style={{ fontWeight: 800 }}>
                      {g.receipt}
                      <span
                        style={{
                          marginLeft: 10,
                          fontSize: 12,
                          color: "#9CA3AF",
                          fontWeight: 600,
                        }}
                      >
                        {g.maxDate || "—"}
                      </span>
                    </div>
                    <div style={{ marginTop: 2, fontSize: 12, color: "#9CA3AF" }}>
                      {totalItems} items · Total {fmtUSD(totalDollars)}
                    </div>
                  </div>

                  <div style={{ color: "#9CA3AF", fontWeight: 800 }}>
                    {isOpen ? "–" : "+"}
                  </div>
                </div>

                {isOpen && (
                  <div style={{ borderTop: "1px solid #1F2937", padding: 12 }}>
                    <div style={{ overflowX: "auto" }}>
                      <table
                        style={{
                          width: "100%",
                          borderCollapse: "collapse",
                          fontSize: 13,
                        }}
                      >
                        <thead>
                          <tr style={{ color: "#9CA3AF" }}>
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
                            .slice()
                            .sort((a, b) => (a.lineId || 0) - (b.lineId || 0))
                            .map((row) => {
                              const receipt = g.receipt;
                              const lineId = row.lineId;
                              const rowKey = `${receipt}::${lineId}`;

                              const desc = mergedValue(row, rowKey, "productDescription");
                              const cat = mergedValue(row, rowKey, "category");
                              const amt = mergedValue(row, rowKey, "amount");

                              return (
                                <tr key={row.sk} style={{ borderTop: "1px solid #1F2937" }}>
                                  <td style={td}>{row.date || "—"}</td>
                                  <td style={td}>{row.productCode || "—"}</td>

                                  <td style={td}>
                                    <input
                                      value={desc}
                                      onChange={(e) =>
                                        setEdit(rowKey, "productDescription", e.target.value)
                                      }
                                      style={input()}
                                    />
                                  </td>

                                  <td style={td}>
                                    <input
                                      value={cat}
                                      onChange={(e) => setEdit(rowKey, "category", e.target.value)}
                                      style={input()}
                                    />
                                  </td>

                                  <td style={{ ...td, textAlign: "right", minWidth: 110 }}>
                                    <input
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

                    <div style={{ marginTop: 10, fontSize: 12, color: "#9CA3AF" }}>
                      Search filters receipts by{" "}
                      <span style={{ color: "#E5E7EB" }}>Product Description</span>.
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
const th = { padding: "10px 8px", fontWeight: 700, fontSize: 12 };
const td = { padding: "10px 8px", verticalAlign: "top" };

function input() {
  return {
    width: "100%",
    background: "#0B1220",
    border: "1px solid #1F2937",
    color: "#F9FAFB",
    padding: "8px 10px",
    borderRadius: 10,
    outline: "none",
    minWidth: 140,
  };
}

function btn(disabled) {
  return {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid #1F2937",
    background: disabled ? "#0B1220" : "#0F172A",
    color: disabled ? "#6B7280" : "#F9FAFB",
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function btnSmall(disabled) {
  return {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #1F2937",
    background: disabled ? "#0B1220" : "#0F172A",
    color: disabled ? "#6B7280" : "#F9FAFB",
    fontWeight: 800,
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
    color: disabled ? "#6B7280" : "#FCA5A5",
    fontWeight: 800,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
