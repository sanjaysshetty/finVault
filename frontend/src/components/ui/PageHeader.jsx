/**
 * PageHeader — page title + optional action buttons row.
 *
 * Props:
 *   title    {string}     page title
 *   children {ReactNode?} action buttons / controls placed on the right
 */
export function PageHeader({ title, children }) {
  return (
    <div className="flex items-center justify-between gap-4 mb-5">
      <h1
        className="text-xl font-black text-slate-200 tracking-tight"
        style={{ fontFamily: "Epilogue, sans-serif" }}
      >
        {title}
      </h1>
      {children && (
        <div className="flex items-center gap-2 flex-wrap">{children}</div>
      )}
    </div>
  );
}
