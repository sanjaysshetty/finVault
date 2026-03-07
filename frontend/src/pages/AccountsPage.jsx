import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";

/* ── Page key display labels ────────────────────────────────── */
const PAGE_LABELS = {
  portfolio:         "Portfolio",
  stocks:            "Stocks",
  crypto:            "Crypto",
  bullion:           "Bullion",
  futures:           "Futures",
  options:           "Options",
  fixedIncome:       "Fixed Income",
  otherAssets:       "Others",
  nav:               "NAV",
  liabilities:       "Liabilities",
  insurance:         "Insurance",
  spendingDashboard: "Spending",
  receiptsLedger:    "Receipts",
};

/* ── Helpers ─────────────────────────────────────────────────── */

function pagesLabel(pages) {
  if (!pages) return "No access";
  const write = Object.values(pages).filter((v) => v === "write").length;
  const read  = Object.values(pages).filter((v) => v === "read").length;
  const total = write + read;
  if (total === 0) return "No access";
  if (write === Object.keys(PAGE_LABELS).length) return "Full access";
  const parts = [];
  if (write) parts.push(`${write}w`);
  if (read)  parts.push(`${read}r`);
  return parts.join(" ") + ` (${total} page${total !== 1 ? "s" : ""})`;
}

function shortId(id) {
  return id ? id.slice(0, 8) + "…" : "—";
}

function permColorCls(val) {
  if (val === "write") return "border-emerald-500/[0.25] bg-emerald-500/[0.1] text-emerald-400";
  if (val === "read")  return "border-blue-500/[0.2] bg-blue-500/[0.08] text-blue-400";
  return "border-white/[0.06] bg-white/[0.02] text-slate-700";
}

/* ── Shared UI primitives ───────────────────────────────────── */

// Matches BtnPrimary style from all other pages
const btnPrimCls =
  "text-xs font-bold text-slate-100 px-3 py-1.5 rounded-lg border border-blue-500/[0.3] " +
  "bg-blue-500/[0.15] hover:bg-blue-500/[0.25] transition-all cursor-pointer " +
  "disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";

const btnGhostCls =
  "px-3 py-1.5 text-xs font-bold rounded-lg border border-white/[0.08] bg-white/[0.03] " +
  "text-slate-400 hover:bg-white/[0.07] hover:text-slate-200 transition-all " +
  "disabled:opacity-50 cursor-pointer whitespace-nowrap";

const btnDangerCls =
  "px-3 py-1.5 text-xs font-bold rounded-lg border border-red-500/30 bg-red-500/[0.08] " +
  "text-red-400 hover:bg-red-500/[0.18] transition-all disabled:opacity-50 cursor-pointer whitespace-nowrap";

function Btn({ onClick, disabled, loading, children, variant = "primary" }) {
  const cls = variant === "ghost" ? btnGhostCls : variant === "danger" ? btnDangerCls : btnPrimCls;
  return (
    <button type="button" onClick={onClick} disabled={disabled || loading} className={cls}>
      {loading ? "…" : children}
    </button>
  );
}

function Badge({ children, color = "slate" }) {
  const styles = {
    blue:  "bg-blue-500/[0.15] text-blue-400",
    green: "bg-emerald-500/[0.15] text-emerald-400",
    slate: "bg-slate-700/40 text-slate-400",
    amber: "bg-amber-500/[0.15] text-amber-400",
  };
  return (
    <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full ${styles[color] || styles.slate}`}>
      {children}
    </span>
  );
}

function Input({ value, onChange, placeholder, className = "" }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={[
        "w-full px-3 py-2 rounded-xl bg-[#080D1A] border border-white/[0.1]",
        "text-slate-200 text-sm placeholder:text-slate-700",
        "focus:outline-none focus:border-blue-500/40 disabled:opacity-50",
        className,
      ].join(" ")}
    />
  );
}

function ErrMsg({ msg }) {
  if (!msg) return null;
  return <p className="text-xs text-red-400 mt-1">{msg}</p>;
}

/* ── Members panel ──────────────────────────────────────────── */
function MembersPanel({ accountId }) {
  const qc = useQueryClient();
  const [err, setErr] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editPages, setEditPages] = useState({});

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.members(accountId),
    queryFn: () => api.get(`/accounts/${accountId}/members`, { accountId }),
  });
  const members = Array.isArray(data) ? data : [];

  const removeMut = useMutation({
    mutationFn: (memberId) =>
      api.delete(`/accounts/${accountId}/members/${memberId}`, { accountId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.members(accountId) }); setErr(""); },
    onError: (e) => setErr(e.detail?.message || e.message),
  });

  const updateMut = useMutation({
    mutationFn: ({ memberId, pages }) =>
      api.patch(`/accounts/${accountId}/members/${memberId}`, { pages }, { accountId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.members(accountId) });
      setEditingId(null);
      setErr("");
    },
    onError: (e) => setErr(e.detail?.message || e.message),
  });

  function startEdit(m) {
    setEditingId(m.userId);
    setEditPages({ ...m.pages });
  }

  function cyclePermission(key) {
    setEditPages((prev) => {
      const cur = prev[key] || "none";
      const next = cur === "none" ? "read" : cur === "read" ? "write" : "none";
      return { ...prev, [key]: next };
    });
  }

  if (isLoading) return <p className="text-sm text-slate-600 py-3">Loading members…</p>;

  return (
    <div>
      <ErrMsg msg={err} />
      {members.length === 0 ? (
        <p className="text-sm text-slate-600 py-3">No members yet.</p>
      ) : (
        <div className="space-y-2">
          {members.map((m) => (
            <div key={m.userId} className="rounded-lg bg-white/[0.02] border border-white/[0.05]">
              {/* Member row */}
              <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm text-slate-300 truncate">{m.email || shortId(m.userId)}</p>
                  <p className="text-xs text-slate-600 mt-0.5">{pagesLabel(m.pages)}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge color={m.role === "owner" ? "blue" : "slate"}>{m.role}</Badge>
                  {m.role !== "owner" && (
                    <>
                      <Btn
                        variant="ghost"
                        onClick={() => editingId === m.userId ? setEditingId(null) : startEdit(m)}
                      >
                        {editingId === m.userId ? "Cancel" : "Edit"}
                      </Btn>
                      <Btn variant="danger" loading={removeMut.isPending} onClick={() => removeMut.mutate(m.userId)}>
                        Remove
                      </Btn>
                    </>
                  )}
                </div>
              </div>

              {/* Inline permission editor */}
              {editingId === m.userId && (
                <div className="border-t border-white/[0.05] px-3 pb-3 pt-2 space-y-2">
                  <p className="text-[11px] text-slate-600 mb-1">
                    Click to cycle:{" "}
                    <span className="text-slate-600">none</span>{" "}→{" "}
                    <span className="text-blue-500">read</span>{" "}→{" "}
                    <span className="text-emerald-500">write</span>
                  </p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {Object.entries(PAGE_LABELS).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => cyclePermission(key)}
                        className={[
                          "px-2 py-1.5 rounded-lg text-xs font-medium border",
                          "transition-all cursor-pointer text-left",
                          permColorCls(editPages[key]),
                        ].join(" ")}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <Btn
                    onClick={() => updateMut.mutate({ memberId: m.userId, pages: editPages })}
                    loading={updateMut.isPending}
                  >
                    Save Permissions
                  </Btn>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Invites panel ──────────────────────────────────────────── */
function InvitesPanel({ accountId }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [inviteErr, setInviteErr] = useState("");
  const [showPerms, setShowPerms] = useState(false);
  const [pages, setPages] = useState(() =>
    Object.fromEntries(Object.keys(PAGE_LABELS).map((k) => [k, "none"]))
  );

  function cyclePermission(key) {
    setPages((prev) => {
      const cur = prev[key] || "none";
      const next = cur === "none" ? "read" : cur === "read" ? "write" : "none";
      return { ...prev, [key]: next };
    });
  }

  const accessSummary = (() => {
    const w = Object.values(pages).filter((v) => v === "write").length;
    const r = Object.values(pages).filter((v) => v === "read").length;
    if (w === 0 && r === 0) return "no access";
    const parts = [];
    if (w) parts.push(`${w} write`);
    if (r) parts.push(`${r} read`);
    return parts.join(", ");
  })();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.invites(accountId),
    queryFn: () => api.get(`/accounts/${accountId}/invites`, { accountId }),
  });
  const invites  = Array.isArray(data) ? data : [];
  const pending  = invites.filter((i) => i.status === "PENDING");
  const accepted = invites.filter((i) => i.status === "ACCEPTED");

  const sendMut = useMutation({
    mutationFn: () =>
      api.post(`/accounts/${accountId}/invites`, { email, pages }, { accountId }),
    onSuccess: () => {
      // Invalidate both — if backend immediately accepted (existing user), Members tab updates too.
      qc.invalidateQueries({ queryKey: queryKeys.invites(accountId) });
      qc.invalidateQueries({ queryKey: queryKeys.members(accountId) });
      setEmail(""); setInviteErr("");
    },
    onError: (e) => setInviteErr(e.detail?.message || e.message),
  });

  const revokeMut = useMutation({
    mutationFn: (addr) =>
      api.delete(`/accounts/${accountId}/invites/${encodeURIComponent(addr)}`, { accountId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.invites(accountId) }),
  });

  return (
    <div>
      {/* Send invite form */}
      <div className="space-y-2.5 mb-5">
        <div className="flex gap-2">
          <Input
            value={email}
            onChange={setEmail}
            placeholder="email@example.com"
            className="flex-1"
          />
          <Btn
            onClick={() => sendMut.mutate()}
            disabled={!email.trim() || !email.includes("@")}
            loading={sendMut.isPending}
          >
            Send Invite
          </Btn>
        </div>
        <ErrMsg msg={inviteErr} />

        {/* Permission picker toggle */}
        <button
          type="button"
          onClick={() => setShowPerms((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
        >
          <span className="text-slate-700 text-[10px]">{showPerms ? "▾" : "▸"}</span>
          Set page permissions
          <span className="text-slate-700 ml-0.5">— {accessSummary}</span>
        </button>

        {showPerms && (
          <div className="pt-1">
            <p className="text-[11px] text-slate-600 mb-2">
              Click to cycle:{" "}
              <span className="text-slate-600">none</span>{" "}→{" "}
              <span className="text-blue-500">read</span>{" "}→{" "}
              <span className="text-emerald-500">write</span>
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              {Object.entries(PAGE_LABELS).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => cyclePermission(key)}
                  className={[
                    "px-2 py-1.5 rounded-lg text-xs font-medium border",
                    "transition-all cursor-pointer text-left",
                    permColorCls(pages[key]),
                  ].join(" ")}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {isLoading && <p className="text-sm text-slate-600">Loading invites…</p>}

      {/* Pending */}
      {pending.length > 0 && (
        <div className="mb-4">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-600 mb-2">Pending</p>
          <div className="space-y-2">
            {pending.map((inv) => (
              <div
                key={inv.emailLower}
                className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.05]"
              >
                <div className="min-w-0">
                  <p className="text-sm text-slate-300 truncate">{inv.emailLower}</p>
                  <p className="text-xs text-slate-600 mt-0.5">{pagesLabel(inv.pages)}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge color="amber">pending</Badge>
                  <Btn variant="danger" loading={revokeMut.isPending} onClick={() => revokeMut.mutate(inv.emailLower)}>
                    Revoke
                  </Btn>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Accepted */}
      {accepted.length > 0 && (
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-slate-600 mb-2">Accepted</p>
          <div className="space-y-2">
            {accepted.map((inv) => (
              <div
                key={inv.emailLower}
                className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.05]"
              >
                <p className="text-sm text-slate-500 truncate">{inv.emailLower}</p>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge color="green">accepted</Badge>
                  <Btn variant="danger" loading={revokeMut.isPending} onClick={() => revokeMut.mutate(inv.emailLower)}>
                    Revoke
                  </Btn>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!isLoading && invites.length === 0 && (
        <p className="text-sm text-slate-600">
          No invites yet. Enter an email above, set permissions, then send.
        </p>
      )}
    </div>
  );
}

/* ── Settings panel (rename + delete) ──────────────────────── */
function SettingsPanel({ account, onDeleted }) {
  const qc = useQueryClient();
  const [nameVal, setNameVal] = useState(account.accountName || "");
  const [renameErr, setRenameErr] = useState("");
  const [showDelete, setShowDelete] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [deleteErr, setDeleteErr] = useState("");

  const renameMut = useMutation({
    mutationFn: (name) =>
      api.patch(`/accounts/${account.accountId}`, { accountName: name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.accounts() });
      setRenameErr("");
    },
    onError: (e) => setRenameErr(e.detail?.message || e.message),
  });

  const deleteMut = useMutation({
    mutationFn: () =>
      api.delete(`/accounts/${account.accountId}`, { accountId: account.accountId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.accounts() });
      if (onDeleted) onDeleted();
    },
    onError: (e) => setDeleteErr(e.detail?.message || e.message),
  });

  const canConfirm = confirmName.trim() === (account.accountName || "").trim();

  return (
    <div className="space-y-6">
      {/* Rename */}
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-slate-600 mb-2">Account Name</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={nameVal}
            onChange={(e) => setNameVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && nameVal.trim()) renameMut.mutate(nameVal.trim());
            }}
            placeholder="Enter account name"
            className="flex-1 px-3 py-2 rounded-xl bg-[#080D1A] border border-white/[0.1] text-slate-200 text-sm placeholder:text-slate-700 focus:outline-none focus:border-blue-500/40"
          />
          <Btn
            onClick={() => renameMut.mutate(nameVal.trim())}
            disabled={!nameVal.trim() || nameVal.trim() === account.accountName}
            loading={renameMut.isPending}
          >
            Save
          </Btn>
        </div>
        {renameErr && <p className="text-xs text-red-400 mt-1">{renameErr}</p>}
      </div>

      {/* Danger zone */}
      <div className="border-t border-white/[0.06] pt-4">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-600 mb-2">Danger Zone</p>
        {account.isPrimary ? (
          <p className="text-xs text-slate-600">Primary account cannot be deleted.</p>
        ) : !showDelete ? (
          <Btn variant="danger" onClick={() => setShowDelete(true)}>
            Delete Account
          </Btn>
        ) : (
          <div className="space-y-3 p-3 rounded-xl bg-red-500/[0.05] border border-red-500/[0.15]">
            <p className="text-xs text-red-400/80 leading-relaxed">
              This will permanently delete this account and{" "}
              <strong>all associated assets and spending transactions</strong>.
              This action cannot be undone.
            </p>
            <p className="text-xs text-slate-400">
              Type{" "}
              <span className="font-mono text-slate-200">{account.accountName || ""}</span>{" "}
              to confirm:
            </p>
            <input
              type="text"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder="Type account name to confirm"
              className="w-full px-3 py-2 rounded-xl bg-[#080D1A] border border-red-500/[0.2] text-slate-200 text-sm placeholder:text-slate-700 focus:outline-none focus:border-red-500/40"
            />
            {deleteErr && <p className="text-xs text-red-400">{deleteErr}</p>}
            <div className="flex gap-2">
              <Btn
                variant="danger"
                onClick={() => deleteMut.mutate()}
                disabled={!canConfirm}
                loading={deleteMut.isPending}
              >
                Delete Account
              </Btn>
              <Btn
                variant="ghost"
                onClick={() => { setShowDelete(false); setConfirmName(""); setDeleteErr(""); }}
              >
                Cancel
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Owned account card ─────────────────────────────────────── */
function OwnedCard({ account, expanded, onToggle, tab, onTabChange, onDeleted }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-[#0F1729] overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-bold text-slate-100 truncate">
              {account.accountName || <span className="text-slate-600 italic">Unnamed</span>}
            </h3>
            {account.isPrimary && <Badge color="slate">primary</Badge>}
            <Badge color="blue">owner</Badge>
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5 truncate">
            {account.ownerEmail || "—"}
          </p>
        </div>
        <Btn variant="ghost" onClick={onToggle}>
          {expanded ? "Close ▴" : "Manage ▾"}
        </Btn>
      </div>

      {expanded && (
        <div className="border-t border-white/[0.06] px-5 py-4">
          <div className="flex gap-1 mb-4">
            {["members", "invites", "settings"].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onTabChange(t)}
                className={[
                  "px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide",
                  "transition-all cursor-pointer",
                  tab === t
                    ? "bg-blue-500/[0.15] text-blue-300 border border-blue-500/[0.2]"
                    : "text-slate-600 hover:text-slate-400 border border-transparent",
                ].join(" ")}
              >
                {t}
              </button>
            ))}
          </div>
          {tab === "members"  && <MembersPanel accountId={account.accountId} />}
          {tab === "invites"  && <InvitesPanel accountId={account.accountId} />}
          {tab === "settings" && <SettingsPanel account={account} onDeleted={onDeleted} />}
        </div>
      )}
    </div>
  );
}

/* ── Shared (member) account card ───────────────────────────── */
function SharedCard({ account }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-[#0F1729] px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-slate-100 truncate">{account.accountName}</h3>
          <p className="text-[11px] text-slate-500 mt-0.5 truncate">{account.ownerEmail || "—"}</p>
          <p className="text-xs text-slate-600 mt-0.5">{pagesLabel(account.pages)}</p>
        </div>
        <Badge color="slate">member</Badge>
      </div>
    </div>
  );
}

/* ── Page ────────────────────────────────────────────────────── */
export default function AccountsPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createErr, setCreateErr]   = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [tab, setTab]               = useState("members");

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.accounts(),
    queryFn: () => api.get("/accounts", { accountId: null }),
  });

  const accounts = Array.isArray(data) ? data : [];
  const owned    = accounts.filter((a) => a.role === "owner");
  const shared   = accounts.filter((a) => a.role === "member");

  const createMut = useMutation({
    mutationFn: (name) => api.post("/accounts", { accountName: name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.accounts() });
      setCreateName(""); setShowCreate(false); setCreateErr("");
    },
    onError: (e) => setCreateErr(e.detail?.message || e.message),
  });

  function toggleExpand(accountId) {
    if (expandedId === accountId) { setExpandedId(null); }
    else { setExpandedId(accountId); setTab("members"); }
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between mb-8">
        <h1
          className="text-3xl font-black text-slate-50 tracking-tight"
          style={{ fontFamily: "Epilogue, sans-serif" }}
        >
          Accounts
        </h1>
        <Btn onClick={() => { setShowCreate((v) => !v); setCreateErr(""); }}>
          {showCreate ? "Cancel" : "+ New Account"}
        </Btn>
      </div>

      {/* New Account form */}
      {showCreate && (
        <div className="mb-6 p-5 rounded-xl bg-[#0F1729] border border-white/[0.08]">
          <p className="text-sm font-bold text-slate-200 mb-1">New Account</p>
          <p className="text-xs text-slate-600 mb-3">
            Creates a separate portfolio. Your existing data stays in{" "}
            <span className="text-slate-400">My Account</span> (primary). Each account is
            independent — assets and transactions are not shared between accounts.
          </p>
          <div className="flex gap-2">
            <Input
              value={createName}
              onChange={setCreateName}
              placeholder="Account name (e.g. Joint Portfolio)"
              className="flex-1"
            />
            <Btn
              onClick={() => createMut.mutate(createName)}
              disabled={!createName.trim()}
              loading={createMut.isPending}
            >
              Create
            </Btn>
          </div>
          <ErrMsg msg={createErr} />
        </div>
      )}

      {isLoading && <p className="text-sm text-slate-600">Loading accounts…</p>}

      {/* Your Accounts */}
      {owned.length > 0 && (
        <section className="mb-8">
          <h2 className="text-xs font-bold uppercase tracking-widest text-slate-600 mb-3">
            Your Accounts
          </h2>
          <div className="space-y-3">
            {owned.map((acct) => (
              <OwnedCard
                key={acct.accountId}
                account={acct}
                expanded={expandedId === acct.accountId}
                onToggle={() => toggleExpand(acct.accountId)}
                tab={tab}
                onTabChange={setTab}
                onDeleted={() => setExpandedId(null)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Shared With Me */}
      {shared.length > 0 && (
        <section>
          <h2 className="text-xs font-bold uppercase tracking-widest text-slate-600 mb-3">
            Shared With Me
          </h2>
          <div className="space-y-3">
            {shared.map((acct) => (
              <SharedCard key={acct.accountId} account={acct} />
            ))}
          </div>
        </section>
      )}

      {!isLoading && accounts.length === 0 && (
        <div className="text-center py-20 text-slate-600">
          <p className="text-4xl mb-3">🏦</p>
          <p className="text-sm">No accounts found. Create one to get started.</p>
        </div>
      )}
    </div>
  );
}
