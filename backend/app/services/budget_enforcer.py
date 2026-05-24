"""Budget enforcement for autovalidate optimization runs.

Shared across KB / extraction / workflow optimizers. Manages token-budget
bookkeeping plus the random-sample-without-replacement trial-count target.
"""

import random
from typing import Any

# Hard cap on planned trials per run, regardless of budget. Prevents
# unbounded DB document growth on very large budgets.
DEFAULT_MAX_TRIAL_COUNT = 100

# Conservative per-trial token estimate used for budget pacing when the
# caller hasn't measured a real per-trial cost yet.
DEFAULT_PER_TRIAL_TOKEN_ESTIMATE = 100_000


class BudgetEnforcer:
    """Stateful budget tracker.

    Caller pattern:
        be = BudgetEnforcer(total_budget=2_500_000, per_trial_estimate=100_000)
        for trial in be.sample_trials(search_space, rng=rng):
            if not be.can_afford_next_trial():
                break
            tokens_used = run_trial(trial)
            be.record_trial(tokens_used)
    """

    def __init__(
        self,
        total_budget: int,
        per_trial_estimate: int = DEFAULT_PER_TRIAL_TOKEN_ESTIMATE,
        max_trial_count: int = DEFAULT_MAX_TRIAL_COUNT,
    ) -> None:
        self.total_budget = max(0, total_budget)
        self.per_trial_estimate = max(1, per_trial_estimate)
        self.max_trial_count = max(0, max_trial_count)
        self.tokens_used = 0

    def remaining(self) -> int:
        return max(0, self.total_budget - self.tokens_used)

    def can_afford_next_trial(self) -> bool:
        """True iff the remaining budget plausibly covers another trial."""
        return self.remaining() >= self.per_trial_estimate

    def record_trial(self, tokens: int) -> None:
        self.tokens_used += max(0, tokens)

    def sample_trials(
        self,
        search_space: list[dict[str, Any]],
        rng: random.Random | None = None,
    ) -> list[dict[str, Any]]:
        """Random sample without replacement; capped by budget and max_trial_count.

        The cap is computed up-front from total_budget / per_trial_estimate so
        the trial roster is known before execution begins.
        """
        rng = rng or random.Random()
        target = min(
            self.max_trial_count,
            max(0, self.total_budget // self.per_trial_estimate),
        )
        if target <= 0:
            return []
        pool = list(search_space)
        rng.shuffle(pool)
        return pool[:target]
