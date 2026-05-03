export function FormModal({ title, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.72)" }}>
      <div className={`bg-[#0F1729] border border-white/[0.08] rounded-2xl w-full shadow-2xl max-h-[90vh] flex flex-col ${wide === "xl" ? "max-w-2xl" : wide ? "max-w-xl" : "max-w-lg"}`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06] shrink-0">
          <h3 className="text-base font-bold text-white" style={{ fontFamily: "Epilogue, sans-serif" }}>{title}</h3>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-300 p-1 rounded-lg hover:bg-white/[0.05] cursor-pointer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-3">{children}</div>
      </div>
    </div>
  );
}
