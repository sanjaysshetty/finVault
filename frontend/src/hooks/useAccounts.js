import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback, useEffect } from "react";
import { api, queryKeys } from "../api/client.js";

/**
 * useAccounts — loads the caller's account list and tracks the active account.
 *
 * activeAccount is resolved as:
 *   1. The account matching the persisted activeAccountId in sessionStorage.
 *   2. The primary account (isPrimary === true).
 *   3. The first account in the list.
 *
 * switchAccount(accountId) persists the selection, updates local state, and
 * invalidates all React Query caches so every page reloads under the new
 * account's context (the new X-Account-Id header is read at fetch time).
 */
export function useAccounts() {
  const queryClient = useQueryClient();

  const [activeAccountId, setActiveAccountId] = useState(
    () => sessionStorage.getItem("finvault.activeAccountId") || ""
  );

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.accounts(),
    queryFn: () => api.get("/accounts", { accountId: null }),
    staleTime: 5 * 60 * 1000,
  });

  const accounts = Array.isArray(data) ? data : [];

  const activeAccount =
    accounts.find((a) => a.accountId === activeAccountId) ||
    accounts.find((a) => a.isPrimary) ||
    accounts[0] ||
    null;

  // Auto-correct stale activeAccountId in sessionStorage.
  // This handles cases like a deleted account whose ID is still persisted —
  // every API call would send that ID as X-Account-Id and get 403 back.
  // When the accounts list loads and the stored ID doesn't match any account,
  // sync sessionStorage + state to the resolved active account and re-fetch.
  useEffect(() => {
    if (accounts.length > 0 && activeAccount && activeAccount.accountId !== activeAccountId) {
      sessionStorage.setItem("finvault.activeAccountId", activeAccount.accountId);
      setActiveAccountId(activeAccount.accountId);
      queryClient.invalidateQueries();
    }
  // Re-run when the accounts list size or resolved account changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.length, activeAccount?.accountId]);

  const switchAccount = useCallback(
    (accountId) => {
      sessionStorage.setItem("finvault.activeAccountId", accountId);
      setActiveAccountId(accountId);
      // Invalidate everything so all pages reload with the new account context.
      queryClient.invalidateQueries();
    },
    [queryClient]
  );

  return { accounts, activeAccount, isLoading, switchAccount };
}
