"""
Dynamic per-candidate dollar allocator for Opportunity Engine's Tower 2
pass.

Confirmed design decision: the weekly scan's total dollar budget is the
true hard ceiling; a per-candidate "cents" figure is only a *starting*
allowance, not an independent fixed cost. Each remaining candidate's
allocation = remaining_budget / remaining_candidate_count, recomputed
fresh immediately before each candidate starts (never precomputed once
up front) -- so the running sum is bounded by total_budget_usd BY
CONSTRUCTION, not by hoping every candidate stays under a fixed limit.
An early candidate finishing under its allocation leaves more room for
later ones; a candidate that runs right up to its own allocation doesn't
blow the total, since the next allocation shrinks accordingly.

Kept local to Opportunity Engine, not the shared layer -- Deep Dive's
cost cap is a fixed per-turn constant and never needs this kind of
splitting.

Not thread-safe by itself: a caller running candidates inside a
ThreadPoolExecutor must hold one shared lock around both
allocate_next_candidate_budget() and record_actual_spend().
"""

from dataclasses import dataclass


@dataclass
class ScanBudget:
    total_budget_usd: float
    spent_usd: float = 0.0

    def remaining(self) -> float:
        return max(0.0, self.total_budget_usd - self.spent_usd)


def allocate_next_candidate_budget(
    scan_budget: ScanBudget,
    remaining_candidate_count: int,
    per_candidate_ceiling_usd: float,
) -> float:
    """remaining_candidate_count MUST include the candidate about to
    start (i.e. the count of candidates that have not yet been submitted,
    counting this one). Returns min(per_candidate_ceiling_usd,
    remaining / count) -- the ceiling stops the first candidate from
    being handed the whole remaining budget just for being first; the
    division is what actually bounds the running total."""
    if remaining_candidate_count <= 0:
        return 0.0
    return max(0.0, min(per_candidate_ceiling_usd, scan_budget.remaining() / remaining_candidate_count))


def record_actual_spend(scan_budget: ScanBudget, spent_usd: float) -> None:
    scan_budget.spent_usd += max(0.0, spent_usd)


def adjust_reservation(scan_budget: ScanBudget, reserved_usd: float, actual_usd: float) -> None:
    """True-up a prior reservation to its real cost.

    Required because a ThreadPoolExecutor submits several candidates'
    work upfront, before any of them complete -- allocate_next_candidate_
    budget's "remaining / count" math would be computed against a stale
    balance for every candidate in that initial burst unless each one's
    allocation is reserved (counted as spent) the moment it's handed out,
    not only once the real cost is known. This reconciles that
    reservation against the real cost once the run finishes: a candidate
    that spent less than it was allocated frees that difference back up
    for whichever candidates haven't started yet; one that spent more
    (shouldn't happen if AgentLoop's own cap is honored, but defensively
    handled here too) debits the difference. Unlike record_actual_spend,
    this deliberately allows the resulting delta to be negative.
    """
    scan_budget.spent_usd += (actual_usd - reserved_usd)
