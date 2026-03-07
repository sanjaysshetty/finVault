/**
 * NoPermissionsPage — shown when a member account has zero page permissions.
 * Informational, friendly, and a little off-beat.
 */
export default function NoPermissionsPage({ accountName }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6 select-none">
      {/* Big lock emoji with subtle glow */}
      <div
        className="text-7xl mb-6"
        style={{ filter: "drop-shadow(0 0 24px rgba(99,102,241,0.45))" }}
      >
        🔐
      </div>

      <h1
        className="text-2xl font-black text-slate-100 mb-2"
        style={{ fontFamily: "Epilogue, sans-serif" }}
      >
        You're in, but the lights aren't on yet.
      </h1>

      <p className="text-slate-400 text-sm max-w-sm mb-6 leading-relaxed">
        You've been added to{" "}
        <span className="text-slate-200 font-semibold">
          {accountName || "this account"}
        </span>
        , but the account owner hasn't flipped the switch on any pages for you
        yet.
      </p>

      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-6 py-4 max-w-xs text-left space-y-2">
        <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">
          What's happening
        </p>
        <Row icon="👤" text="Your membership is active" />
        <Row icon="📋" text="No page permissions assigned yet" />
        <Row icon="⏳" text="Ask the account owner to grant access" />
      </div>

      <p className="mt-8 text-xs text-slate-600 italic">
        "A house without keys is just a very expensive box."
      </p>
    </div>
  );
}

function Row({ icon, text }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-base">{icon}</span>
      <span className="text-sm text-slate-400">{text}</span>
    </div>
  );
}
