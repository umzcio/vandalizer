"""Judge variance sampler — measures nondeterminism in LLM-judge scores.

Used by autovalidate runs to compute a confidence interval on lift readouts.
Without it, a "+3 pts" win could be entirely judge noise; with it, the UI can
flag "no significant change" when the lift is inside the noise floor.

Shared across KB / extraction / workflow optimizers. Each domain provides:
* a list of pre-judged samples (the optimizer's existing judge call results)
* a judge callable that re-evaluates one sample

The sampler picks up to ``max_samples`` (default 2) items, re-runs the judge
once each, and returns the stddev of the delta between original and replay
scores. n=1..2 is small but adequate as a noise floor — costs are low this way.
"""

from typing import Awaitable, Callable, TypeVar

S = TypeVar("S")


async def sample_judge_variance(
    samples: list[S],
    judge_fn: Callable[[S], Awaitable[tuple[float, int]]],
    original_score: Callable[[S], float],
    max_samples: int = 2,
) -> tuple[float | None, int]:
    """Re-judge a small sample to estimate judge nondeterminism.

    Args:
        samples: pre-filtered list of items the caller wants to re-judge.
            The caller decides what filtering applies (e.g., skip SKIPPED
            verdicts). The sampler trusts the list as-is.
        judge_fn: async callable that re-evaluates one sample and returns
            ``(score, tokens_used)``. Exceptions are swallowed (best-effort
            sampling).
        original_score: extracts the *original* score from a sample for
            delta computation.
        max_samples: how many items to re-judge. Default 2.

    Returns:
        ``(stddev | None, tokens_used)``. None when fewer than 2 deltas
        could be collected. Tokens accumulate across attempted re-judges
        even when the variance estimate is inconclusive, so the caller's
        budget tracking stays accurate.
    """
    if len(samples) < 2:
        return (None, 0)

    sample_subset = samples[:max_samples]
    deltas: list[float] = []
    tokens_used = 0
    for s in sample_subset:
        try:
            replay_score, replay_tokens = await judge_fn(s)
            deltas.append(abs(original_score(s) - replay_score))
            tokens_used += max(0, int(replay_tokens))
        except Exception:
            continue

    if len(deltas) < 2:
        return (None, tokens_used)

    mean = sum(deltas) / len(deltas)
    variance = sum((x - mean) ** 2 for x in deltas) / len(deltas)
    return (round(variance ** 0.5, 4), tokens_used)
