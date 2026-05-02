export function PageHeader({ title, icon, subtitle, children }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2.5 min-w-0">
        {icon && (
          <span className="shrink-0" style={{ color: "var(--fv-nav-active-text, #3DD68C)" }}>
            {icon}
          </span>
        )}
        <div className="min-w-0 flex items-baseline gap-2 flex-wrap">
          <h1
            className="text-xl font-black tracking-tight shrink-0"
            style={{ color: "var(--fv-text)", fontFamily: "'Epilogue', sans-serif", letterSpacing: "-0.3px" }}
          >
            {title}
          </h1>
          {subtitle && (
            <span className="text-xs" style={{ color: "var(--fv-dim)" }}>{subtitle}</span>
          )}
        </div>
      </div>
      {children && (
        <div className="flex items-center gap-2 flex-wrap shrink-0">{children}</div>
      )}
    </div>
  );
}
