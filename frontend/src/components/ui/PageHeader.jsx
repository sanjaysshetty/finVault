/**
 * PageHeader — page title + optional icon, subtitle, and action buttons.
 *
 * Props:
 *   title    {string}     page title
 *   icon     {ReactNode?} SVG icon displayed to the left of the title
 *   subtitle {ReactNode?} small text shown below the title (e.g. "As of …")
 *   children {ReactNode?} action buttons / controls placed on the right
 */
export function PageHeader({ title, icon, subtitle, children }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2.5 min-w-0">
        {icon && (
          <span className="text-blue-400 opacity-75 shrink-0">{icon}</span>
        )}
        <div className="min-w-0">
          <h1
            className="text-2xl font-black text-slate-100 tracking-tight"
            style={{ fontFamily: "Epilogue, sans-serif" }}
          >
            {title}
          </h1>
          {subtitle && (
            <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
          )}
        </div>
      </div>
      {children && (
        <div className="flex items-center gap-2 flex-wrap shrink-0">{children}</div>
      )}
    </div>
  );
}
