/* PageIcons — same paths as SideNav, rendered at w-5 h-5 for page headers */
function Icon({ d }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-5 h-5 shrink-0"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

export const PageIcons = {
  portfolio:    <Icon d="M4 5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5zm9 0a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V5zm0 8a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-6zm-9 2a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4z" />,
  capitalGains: <Icon d="M7 16V4m0 0L3 8m4-4 4 4M17 8v12m0 0 4-4m-4 4-4-4" />,
  nav:          <Icon d="M12 3v1m0 16v1M4.22 4.22l.7.7m12.16 12.16.7.7M1 12h1m18 0h1M4.22 19.78l.7-.7M18.36 5.64l.7-.7M12 7a5 5 0 1 1 0 10A5 5 0 0 1 12 7z" />,
  stocks:       <Icon d="M3 17l4-8 4 4 4-6 4 3" />,
  crypto:       <Icon d="M9.5 2A2.5 2.5 0 0 1 12 4.5V5a1 1 0 0 0 1 1h1a2 2 0 0 1 0 4h-1a1 1 0 0 0-1 1v.5a2.5 2.5 0 0 1-5 0V11a1 1 0 0 0-1-1H5a2 2 0 0 1 0-4h1a1 1 0 0 0 1-1v-.5A2.5 2.5 0 0 1 9.5 2z" />,
  bullion:      <Icon d="M5 8h14l-1 9H6L5 8zM3 5h18M9 5V3h6v2" />,
  futures:      <Icon d="M8 7h8M8 12h8M8 17h5m3-5 2 2 2-2" />,
  options:      <Icon d="M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />,
  fixedIncome:  <Icon d="M4 7h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7zm4 0V5a2 2 0 0 1 4 0v2" />,
  otherAssets:  <Icon d="M5 12h.01M12 12h.01M19 12h.01M6 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm7 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm7 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" />,
  liabilities:  <Icon d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2" />,
  insurance:    <Icon d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0 1 12 2.944a11.955 11.955 0 0 1-8.618 3.04A12.02 12.02 0 0 0 3 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />,
  spendingDash: <Icon d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 0 0 3-3V8a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3z" />,
  spending:     <Icon d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />,
  wheelScan:    <Icon d="M21 21l-6-6m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0z" />,
  assetHub:     <Icon d="M19 11H5m14 0a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2m14 0V9a2 2 0 0 0-2-2M5 11V9a2 2 0 0 1 2-2m0 0V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2M7 7h10" />,
  compass:      <Icon d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm3.5 6.5-2 6-6 2 2-6 6-2z" />,
  paperTrading: <Icon d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9l2 2 4-4" />,
};
