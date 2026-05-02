import { FormModal } from "./FormModal.jsx";

export function DeleteConfirmModal({
  title,
  message,
  confirmLabel = "Delete",
  deleting = false,
  error = "",
  onConfirm,
  onClose,
  children,
}) {
  return (
    <FormModal title={title} onClose={onClose}>
      {children && (
        <div className="p-3 rounded-xl bg-red-500/[0.07] border border-red-500/20 text-sm text-slate-300 space-y-1">
          {children}
        </div>
      )}
      <p className="text-xs text-red-400">{message}</p>
      {error ? <p className="text-red-400 text-xs">{error}</p> : null}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onConfirm}
          disabled={deleting}
          className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex-1"
        >
          {deleting ? "Deleting…" : confirmLabel}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-slate-400 hover:text-slate-200 hover:bg-white/[0.05] text-xs font-medium transition-all disabled:opacity-50 cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </FormModal>
  );
}
