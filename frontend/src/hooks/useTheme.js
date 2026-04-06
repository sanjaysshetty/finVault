/**
 * useTheme — dark / light theme for finVault.
 *
 * Auto-mode (default): switches based on Central Time.
 *   Dark  → 6:30 PM – 6:30 AM CT
 *   Light → 6:30 AM – 6:30 PM CT
 *
 * Manual override: toggling stores "light" or "dark" in localStorage.
 * Storing "auto" (or clearing) returns to time-based switching.
 *
 * The hook re-evaluates every minute so the switch happens live.
 */
import { useState, useEffect, useCallback, useRef } from "react";

const STORAGE_KEY = "finvault.theme";

/** Returns "dark" or "light" based on current Central Time. */
function getAutoTheme() {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(new Date());
    const h = parseInt(parts.find((p) => p.type === "hour").value, 10);
    const m = parseInt(parts.find((p) => p.type === "minute").value, 10);
    const totalMins = h * 60 + m;
    // Dark between 18:30 (1110) and 06:30 (390) next morning
    return totalMins >= 18 * 60 + 30 || totalMins < 6 * 60 + 30 ? "dark" : "light";
  } catch (_) {
    return "dark"; // fallback if Intl unavailable
  }
}

function getSavedPreference() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch (_) {}
  return null; // null = auto
}

function resolveTheme() {
  return getSavedPreference() ?? getAutoTheme();
}

function applyTheme(theme) {
  if (theme === "light") {
    document.documentElement.classList.add("light");
  } else {
    document.documentElement.classList.remove("light");
  }
}

// Apply synchronously before first React render to prevent flash
applyTheme(resolveTheme());

export function useTheme() {
  const [theme, setTheme] = useState(resolveTheme);
  // Track whether the user has a manual override active
  const [isManual, setIsManual] = useState(() => getSavedPreference() !== null);
  const timerRef = useRef(null);

  // Apply theme to <html> whenever it changes
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Re-evaluate every minute; only updates if no manual override
  useEffect(() => {
    function tick() {
      if (getSavedPreference() === null) {
        setTheme(getAutoTheme());
      }
    }

    // Fire at the next whole minute boundary, then every 60 s
    const now = new Date();
    const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();

    timerRef.current = setTimeout(() => {
      tick();
      timerRef.current = setInterval(tick, 60_000);
    }, msUntilNextMinute);

    return () => {
      clearTimeout(timerRef.current);
      clearInterval(timerRef.current);
    };
  }, []);

  /** Toggle between dark/light (manual override). */
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      try { localStorage.setItem(STORAGE_KEY, next); } catch (_) {}
      setIsManual(true);
      return next;
    });
  }, []);

  /** Reset to automatic time-based switching. */
  const resetToAuto = useCallback(() => {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    setIsManual(false);
    setTheme(getAutoTheme());
  }, []);

  return { theme, toggle, resetToAuto, isManual, isDark: theme === "dark" };
}
