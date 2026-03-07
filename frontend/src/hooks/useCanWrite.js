import { useAccounts } from "./useAccounts.js";

/**
 * Returns true if the active account has write permission for the given page.
 * Owners always have write access. Members need pages[pageKey] === "write".
 */
export function useCanWrite(pageKey) {
  const { activeAccount } = useAccounts();
  if (!activeAccount) return false;
  if (activeAccount.role === "owner") return true;
  return (activeAccount.pages?.[pageKey] || "none") === "write";
}

/**
 * Returns true if the active account has any access (read or write) to the given page.
 * Owners always pass. Members need pages[pageKey] !== "none".
 */
export function useCanRead(pageKey) {
  const { activeAccount } = useAccounts();
  if (!activeAccount) return true; // optimistic until loaded
  if (activeAccount.role === "owner") return true;
  return (activeAccount.pages?.[pageKey] || "none") !== "none";
}

/**
 * Returns true if all pages are "none" (member with no permissions granted yet).
 */
export function useHasNoPermissions() {
  const { activeAccount } = useAccounts();
  if (!activeAccount) return false;
  if (activeAccount.role === "owner") return false;
  const pages = activeAccount.pages || {};
  return Object.values(pages).every((v) => v === "none");
}
