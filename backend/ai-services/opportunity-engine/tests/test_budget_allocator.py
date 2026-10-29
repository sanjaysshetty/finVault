"""
Unit tests for budget_allocator.py -- the dynamic per-candidate dollar
allocator that keeps Opportunity Engine's weekly scan total mathematically
bounded (the guardrail the 2026-10-26 cost incident required).

Run with: python3 -m unittest tests.test_budget_allocator -v
(from backend/ai-services/opportunity-engine/)
"""

import unittest

from budget_allocator import ScanBudget, adjust_reservation, allocate_next_candidate_budget, record_actual_spend


class TestAllocateNextCandidateBudget(unittest.TestCase):
    def test_even_split_across_remaining_candidates(self):
        budget = ScanBudget(total_budget_usd=0.20)
        allocation = allocate_next_candidate_budget(budget, remaining_candidate_count=5, per_candidate_ceiling_usd=0.10)
        self.assertAlmostEqual(allocation, 0.04, places=6)  # 0.20 / 5

    def test_per_candidate_ceiling_caps_first_candidate(self):
        # Without the ceiling, the first of 2 candidates could claim the
        # whole $0.20 just for being first -- the ceiling prevents that.
        budget = ScanBudget(total_budget_usd=0.20)
        allocation = allocate_next_candidate_budget(budget, remaining_candidate_count=2, per_candidate_ceiling_usd=0.05)
        self.assertEqual(allocation, 0.05)

    def test_allocation_shrinks_as_remaining_budget_drops(self):
        budget = ScanBudget(total_budget_usd=0.20)
        first = allocate_next_candidate_budget(budget, remaining_candidate_count=5, per_candidate_ceiling_usd=0.10)
        record_actual_spend(budget, first)  # candidate used its full allocation
        second = allocate_next_candidate_budget(budget, remaining_candidate_count=4, per_candidate_ceiling_usd=0.10)
        self.assertAlmostEqual(second, 0.04, places=6)  # (0.20 - 0.04) / 4

    def test_early_underspend_leaves_more_for_later_candidates(self):
        budget = ScanBudget(total_budget_usd=0.20)
        allocated_first = allocate_next_candidate_budget(budget, remaining_candidate_count=5, per_candidate_ceiling_usd=0.10)
        record_actual_spend(budget, allocated_first * 0.5)  # candidate only spent half its allocation
        second = allocate_next_candidate_budget(budget, remaining_candidate_count=4, per_candidate_ceiling_usd=0.10)
        self.assertGreater(second, allocated_first)  # more room now that the first underspent

    def test_zero_remaining_candidates_returns_zero(self):
        budget = ScanBudget(total_budget_usd=0.20)
        self.assertEqual(allocate_next_candidate_budget(budget, remaining_candidate_count=0, per_candidate_ceiling_usd=0.10), 0.0)

    def test_exhausted_budget_returns_zero(self):
        budget = ScanBudget(total_budget_usd=0.20, spent_usd=0.20)
        allocation = allocate_next_candidate_budget(budget, remaining_candidate_count=3, per_candidate_ceiling_usd=0.10)
        self.assertEqual(allocation, 0.0)

    def test_sum_of_allocations_never_exceeds_total_budget(self):
        # The single most important property: simulate N candidates each
        # consuming their FULL allocated cap (the worst case) and assert
        # cumulative spend never crosses total_budget_usd.
        budget = ScanBudget(total_budget_usd=0.20)
        n = 6
        for i in range(n):
            remaining_count = n - i
            allocation = allocate_next_candidate_budget(budget, remaining_count, per_candidate_ceiling_usd=0.10)
            record_actual_spend(budget, allocation)  # worst case: candidate spends its entire allocation
            self.assertLessEqual(budget.spent_usd, budget.total_budget_usd + 1e-9)
        self.assertAlmostEqual(budget.spent_usd, budget.total_budget_usd, places=6)

    def test_sum_never_exceeds_budget_even_with_ceiling_binding_every_time(self):
        # Ceiling binds on every candidate (ceiling < even split) -- the
        # allocator must still never let the sum exceed the total budget.
        budget = ScanBudget(total_budget_usd=0.20)
        n = 3
        total_allocated = 0.0
        for i in range(n):
            allocation = allocate_next_candidate_budget(budget, n - i, per_candidate_ceiling_usd=0.10)
            record_actual_spend(budget, allocation)
            total_allocated += allocation
        self.assertLessEqual(total_allocated, 0.20 + 1e-9)


class TestAdjustReservation(unittest.TestCase):
    def test_underspend_frees_up_budget(self):
        budget = ScanBudget(total_budget_usd=0.20, spent_usd=0.10)  # 0.10 reserved for an in-flight candidate
        adjust_reservation(budget, reserved_usd=0.10, actual_usd=0.02)  # it actually only cost $0.02
        self.assertAlmostEqual(budget.spent_usd, 0.02, places=6)

    def test_exact_match_leaves_spent_unchanged(self):
        budget = ScanBudget(total_budget_usd=0.20, spent_usd=0.10)
        adjust_reservation(budget, reserved_usd=0.10, actual_usd=0.10)
        self.assertAlmostEqual(budget.spent_usd, 0.10, places=6)

    def test_overspend_debits_the_difference(self):
        # Shouldn't happen if AgentLoop's own cap is honored, but handled
        # defensively rather than silently under-counting real spend.
        budget = ScanBudget(total_budget_usd=0.20, spent_usd=0.10)
        adjust_reservation(budget, reserved_usd=0.10, actual_usd=0.12)
        self.assertAlmostEqual(budget.spent_usd, 0.12, places=6)

    def test_concurrent_burst_reservation_then_true_up_never_exceeds_budget(self):
        # Reproduces the real bug this function fixes: a ThreadPoolExecutor
        # submits several candidates upfront, before any complete --
        # without reserving at submission time, allocate_next_candidate_
        # budget's math sees a stale (too-large) remaining balance for
        # every candidate in that initial burst.
        budget = ScanBudget(total_budget_usd=0.20)
        n = 6
        reservations = []
        for i in range(n):
            remaining_count = n - i
            cap = allocate_next_candidate_budget(budget, remaining_count, per_candidate_ceiling_usd=0.10)
            record_actual_spend(budget, cap)  # reserve immediately, before this candidate starts running
            reservations.append(cap)
        self.assertAlmostEqual(budget.spent_usd, 0.20, places=6)  # fully reserved, as expected

        # Now true up each one as its real (smaller) cost comes in.
        for reserved in reservations:
            adjust_reservation(budget, reserved_usd=reserved, actual_usd=reserved * 0.1)  # each only cost 10% of its allocation
        self.assertAlmostEqual(budget.spent_usd, 0.20 * 0.1, places=6)
        self.assertLessEqual(budget.spent_usd, budget.total_budget_usd)


class TestScanBudget(unittest.TestCase):
    def test_remaining_never_goes_negative(self):
        budget = ScanBudget(total_budget_usd=0.10, spent_usd=0.15)
        self.assertEqual(budget.remaining(), 0.0)

    def test_record_actual_spend_accumulates(self):
        budget = ScanBudget(total_budget_usd=1.0)
        record_actual_spend(budget, 0.1)
        record_actual_spend(budget, 0.2)
        self.assertAlmostEqual(budget.spent_usd, 0.3, places=6)

    def test_record_actual_spend_ignores_negative_values(self):
        budget = ScanBudget(total_budget_usd=1.0)
        record_actual_spend(budget, -0.5)
        self.assertEqual(budget.spent_usd, 0.0)


if __name__ == "__main__":
    unittest.main()
