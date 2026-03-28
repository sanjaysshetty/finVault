/**
 * PageIcons — SVG icons for page headers (w-6 h-6, matching sidebar icons
 * but slightly larger than the w-4 h-4 nav items).
 */
function Icon({ children }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      className="w-6 h-6 shrink-0"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const PageIcons = {
  portfolio: (
    <Icon>
      <rect x="4" y="6" width="16" height="12" rx="2.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 11h4" />
    </Icon>
  ),
  stocks: (
    <Icon>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18V12M11 18V8M16 18v-5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 18h16" />
    </Icon>
  ),
  crypto: (
    <Icon>
      <circle cx="12" cy="12" r="8" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v10M9.5 9.5h4a2 2 0 1 1 0 4h-4" />
    </Icon>
  ),
  bullion: (
    <Icon>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l3-6h8l3 6H5z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4 6 4-6" />
    </Icon>
  ),
  futures: (
    <Icon>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h8l-1.8-1.8M16 17H8l1.8 1.8" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a5 5 0 0 1 0 10M8 17a5 5 0 0 1 0-10" />
    </Icon>
  ),
  options: (
    <Icon>
      <circle cx="12" cy="12" r="8" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3" />
    </Icon>
  ),
  fixedIncome: (
    <Icon>
      <rect x="4" y="7" width="16" height="10" rx="2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h8M8 14h5" />
      <circle cx="17" cy="14" r="1.2" />
    </Icon>
  ),
  otherAssets: (
    <Icon>
      <circle cx="7" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="17" cy="12" r="1.5" />
    </Icon>
  ),
  nav: (
    <Icon>
      <circle cx="12" cy="12" r="7" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 12l3.5-2.5" />
      <circle cx="12" cy="12" r="1" />
    </Icon>
  ),
  liabilities: (
    <Icon>
      <rect x="4" y="5" width="16" height="14" rx="2.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 11h4M16 14h3" />
    </Icon>
  ),
  insurance: (
    <Icon>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l7 3v6c0 5-3.2 8-7 9-3.8-1-7-4-7-9V6l7-3z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.5 12.5l1.7 1.8 3.3-3.7" />
    </Icon>
  ),
  spendingDash: (
    <Icon>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="5" rx="1.5" />
      <rect x="13" y="11" width="7" height="9" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
    </Icon>
  ),
  spending: (
    <Icon>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 4h10v16l-2-1.3L13 20l-2-1.3L9 20l-2-1.3L5 20V6a2 2 0 0 1 2-2z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 9h6M9 12h6" />
    </Icon>
  ),
  wheelScan: (
    <Icon>
      <circle cx="11" cy="11" r="7" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 16.5l4 4" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 11h6M11 8v6" />
    </Icon>
  ),
};
