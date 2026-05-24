"""Extraction optimizer — wraps the tuning service with baselines + persistence.

Where ``extraction_tuning_service.find_best_settings_stream`` is a primitive
(sweep N configs, stream results), this orchestrator builds the full
"Improve extraction quality" loop:

1. **Measure baselines** so the user can answer "is this extraction earning
   its complexity?":
   * ``baseline_no_tool`` — run extraction with no user config (just system
     defaults). The "what does the LLM do with no help?" floor.
   * ``baseline_default`` — run extraction with the user's currently-applied
     effective config (override-or-authored).
2. **Run the sweep** via the existing tuning service.
3. **Persist** baselines + trials + winner to ``ExtractionOptimizationRun``
   so the UI can poll progress and the optimizer can be cancelled/applied.
4. **Optionally apply** the best config back to the SearchSet.

Phase 1A: strict-match scoring only (no LLM judge — that's Phase 1B).
"""

from __future__ import annotations

import datetime
import logging
from typing import Any

from app.models.extraction_optimization_run import ExtractionOptimizationRun
from app.models.extraction_test_case import ExtractionTestCase
from app.models.search_set import SearchSet
from app.models.system_config import SystemConfig
from app.services.config_service import get_user_model_name
from app.services.extraction_tuning_service import (
    _build_candidate_configs,
    _run_single_config,
)
from app.services.search_set_service import (
    effective_extraction_config,
    get_extraction_field_metadata,
    get_extraction_keys,
)

logger = logging.getLogger(__name__)

# Per-trial token estimate for budget bookkeeping (Phase 1A: rough — we don't
# yet measure per-trial tokens, so this is a pessimistic ceiling that controls
# how many trials fit in a tier).
EXTRACTION_PER_TRIAL_TOKEN_ESTIMATE = 50_000

# How many runs per trial for accuracy/consistency measurement.
DEFAULT_NUM_RUNS_PER_TRIAL = 2


async def run_optimization(
    search_set_uuid: str,
    user_id: str,
    run_uuid: str,
    budget_tokens: int = 0,
    apply_on_finish: bool = False,
    max_candidates: int = 8,
    num_runs: int = DEFAULT_NUM_RUNS_PER_TRIAL,
    include_judge: bool = False,
) -> ExtractionOptimizationRun:
    """Execute the full optimization loop. Caller pre-allocates the run doc.

    The optimizer flow mirrors KB Autovalidate:

    1. Allocate / fetch the pre-created ``ExtractionOptimizationRun``
    2. Establish baselines (no-tool, default-config)
    3. Sweep ``max_candidates`` configs from ``_build_candidate_configs``
       (budget-capped from ``budget_tokens`` if non-zero)
    4. Pick the winner; optionally apply back to ``SearchSet.extraction_config_override``
    5. Mark run completed

    Raises ``ValueError`` on missing keys / test cases. The caller wraps this
    in a Celery task that catches and marks the run failed.
    """
    run_doc = await ExtractionOptimizationRun.find_one(
        ExtractionOptimizationRun.uuid == run_uuid,
    )
    if not run_doc:
        raise ValueError(f"ExtractionOptimizationRun not found: {run_uuid}")

    try:
        await _update(run_doc, status="running", phase="preparing",
                      progress_message="Loading test cases…")

        keys = await get_extraction_keys(search_set_uuid)
        if not keys:
            raise ValueError("No extraction fields defined")

        test_cases = await ExtractionTestCase.find(
            ExtractionTestCase.search_set_uuid == search_set_uuid,
        ).to_list()
        test_cases = [tc for tc in test_cases if tc.expected_values
                      and any(v for v in tc.expected_values.values())]
        if not test_cases:
            raise ValueError(
                "No test cases with expected values found. "
                "Create test cases first (or use 'Create from extraction' to bootstrap).",
            )

        sys_config = await SystemConfig.get_config()
        sys_config_doc = sys_config.model_dump() if sys_config else {}
        field_metadata = await get_extraction_field_metadata(search_set_uuid)
        ss = await SearchSet.find_one(SearchSet.uuid == search_set_uuid)

        # Resolve a default model for baselines (the user's current model)
        baseline_model = await get_user_model_name(user_id)
        # Judge model: same as user's current. (Phase 1B uses the user's
        # model for both extraction and judging — Phase 2 could let admins
        # configure a separate, stronger judge.)
        judge_model = baseline_model if include_judge else None
        if include_judge:
            run_doc.judge_model = judge_model
            await run_doc.save()

        # --- Phase 1: baselines (no-tool, default) ---
        await _update(run_doc, phase="baselines",
                      progress_message="Measuring baselines…")

        no_tool_result = await _run_single_config(
            candidate={
                "label": "baseline-no-tool",
                "model": baseline_model,
                "config_override": {},
            },
            keys=keys,
            test_cases=test_cases,
            sys_config_doc=sys_config_doc,
            field_metadata=field_metadata,
            num_runs=num_runs,
            judge_model=judge_model,
        )
        run_doc.baseline_no_tool_score = _score_to_unit(no_tool_result.get("score"))
        await run_doc.save()

        default_cfg = effective_extraction_config(ss)
        default_result = await _run_single_config(
            candidate={
                "label": "baseline-default",
                "model": default_cfg.get("model") or baseline_model,
                "config_override": default_cfg or {},
            },
            keys=keys,
            test_cases=test_cases,
            sys_config_doc=sys_config_doc,
            field_metadata=field_metadata,
            num_runs=num_runs,
            judge_model=judge_model,
        )
        run_doc.baseline_default_score = _score_to_unit(default_result.get("score"))
        await run_doc.save()

        # Judge variance — sample-resample 2 judged items from the default
        # baseline to estimate judge nondeterminism. Drives the ±N pts CI
        # display in the comparison card. Only meaningful when judge is on.
        if judge_model:
            samples = default_result.get("judge_samples") or []
            if len(samples) >= 2:
                from app.services.judge_variance import sample_judge_variance
                from app.services.extraction_judge import judge_field_value

                async def _rejudge(sample: dict) -> tuple[float, int]:
                    v = await judge_field_value(
                        field_name=sample["field_name"],
                        expected=sample["expected"],
                        actual=sample["actual"],
                        model_name=judge_model,
                    )
                    return float(v["score"]), int(v.get("tokens_used", 0) or 0)

                variance, _variance_tokens = await sample_judge_variance(
                    samples=samples,
                    judge_fn=_rejudge,
                    original_score=lambda s: float(s["score"]),
                    max_samples=2,
                )
                if variance is not None:
                    run_doc.judge_variance = variance
                    await run_doc.save()

        if _is_cancelled(run_doc):
            return await _finalize_cancelled(run_doc)

        # --- Phase 2: trial sweep ---
        await _update(run_doc, phase="sweep",
                      progress_message="Trying configurations…")

        candidates = _build_candidate_configs(
            sys_config.available_models if sys_config else [],
            len(keys),
        )
        # Budget cap (Phase 1A: optional — caller may pass budget_tokens=0 to
        # use max_candidates directly)
        if budget_tokens > 0:
            from app.services.budget_enforcer import BudgetEnforcer
            enforcer = BudgetEnforcer(
                total_budget=budget_tokens,
                per_trial_estimate=EXTRACTION_PER_TRIAL_TOKEN_ESTIMATE,
                max_trial_count=max_candidates,
            )
            candidates = enforcer.sample_trials(candidates)
        else:
            candidates = candidates[:max_candidates]

        run_doc.total_trials_planned = len(candidates)
        await run_doc.save()

        trial_results: list[dict] = []
        # Parallel to trial_results, keyed by label — lets the finalize phase
        # retrieve the raw _run_single_config output (with field_breakdown +
        # judge_samples) for the winning trial.
        raw_by_label: dict[str, dict] = {}
        for i, candidate in enumerate(candidates):
            if _is_cancelled(run_doc):
                return await _finalize_cancelled(run_doc)

            await _update(
                run_doc,
                current_trial_index=i + 1,
                progress_message=f"Trying {candidate['label']}…",
            )

            try:
                result = await _run_single_config(
                    candidate=candidate,
                    keys=keys,
                    test_cases=test_cases,
                    sys_config_doc=sys_config_doc,
                    field_metadata=field_metadata,
                    num_runs=num_runs,
                    judge_model=judge_model,
                )
            except Exception as e:
                logger.warning("Trial %s failed: %s", candidate["label"], e)
                result = {
                    "label": candidate["label"],
                    "model": candidate["model"],
                    "config_override": candidate["config_override"],
                    "accuracy": 0.0,
                    "consistency": 0.0,
                    "score": 0.0,
                    "elapsed_seconds": 0.0,
                    "error": str(e),
                }

            trial_summary = _to_trial_summary(result, baseline_default_score=run_doc.baseline_default_score)
            trial_results.append(trial_summary)
            raw_by_label[trial_summary["trial_id"]] = result

            # Update best-so-far ticker
            score_unit = _score_to_unit(result.get("score"))
            if score_unit is not None and (
                run_doc.best_score_so_far is None or score_unit > run_doc.best_score_so_far
            ):
                run_doc.best_score_so_far = score_unit
                run_doc.best_config_so_far = _trial_config_for_run(result)

            run_doc.trials = trial_results
            await run_doc.save()

        # --- Phase 3: finalize ---
        await _update(run_doc, phase="finalizing",
                      progress_message="Finalizing results…")

        # Best trial = highest score (ties broken by faster elapsed)
        sorted_trials = sorted(
            trial_results,
            key=lambda t: (-(t.get("score") or 0), t.get("duration_seconds") or 0),
        )
        if sorted_trials:
            best = sorted_trials[0]
            run_doc.optimized_score = best.get("score")
            run_doc.best_config = best.get("config")
            # Pull the winning trial's field_breakdown for the recommendations engine
            best_raw = raw_by_label.get(best["trial_id"]) or {}
            run_doc.field_breakdown = list(best_raw.get("field_breakdown") or [])

            # Generate per-field suggestions from the breakdown + baselines
            run_doc.suggestions = _generate_suggestions(
                field_breakdown=run_doc.field_breakdown,
                baseline_no_tool=run_doc.baseline_no_tool_score,
                baseline_default=run_doc.baseline_default_score,
                optimized=run_doc.optimized_score,
            )

        # Apply-on-finish: write best config to override
        if apply_on_finish and run_doc.best_config:
            await _apply_best(ss, run_doc)

        run_doc.status = "completed"
        run_doc.phase = "done"
        run_doc.progress_message = "Optimization complete"
        run_doc.completed_at = datetime.datetime.now(tz=datetime.timezone.utc)
        await run_doc.save()

        return run_doc

    except Exception as e:
        logger.exception("Optimization failed for %s", search_set_uuid)
        run_doc.status = "failed"
        run_doc.phase = "failed"
        run_doc.error_message = str(e)
        run_doc.completed_at = datetime.datetime.now(tz=datetime.timezone.utc)
        await run_doc.save()
        return run_doc


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _update(run_doc: ExtractionOptimizationRun, **fields: Any) -> None:
    for k, v in fields.items():
        setattr(run_doc, k, v)
    await run_doc.save()


def _is_cancelled(run_doc: ExtractionOptimizationRun) -> bool:
    return bool(run_doc.cancel_requested)


async def _finalize_cancelled(run_doc: ExtractionOptimizationRun) -> ExtractionOptimizationRun:
    run_doc.status = "cancelled"
    run_doc.phase = "cancelled"
    run_doc.progress_message = "Cancelled by user"
    run_doc.completed_at = datetime.datetime.now(tz=datetime.timezone.utc)
    await run_doc.save()
    return run_doc


def _score_to_unit(score: float | None) -> float | None:
    """Tuning service returns scores 0..100; optimization run stores 0..1 for
    consistency with KB Autovalidate (so the same comparison-card UI works).
    """
    if score is None:
        return None
    return round(float(score) / 100.0, 4)


def _trial_config_for_run(result: dict) -> dict:
    """Project a tuning result into the per-trial config shape the UI consumes."""
    cfg = dict(result.get("config_override") or {})
    cfg["model"] = result.get("model")
    return cfg


def _to_trial_summary(result: dict, baseline_default_score: float | None) -> dict:
    """Normalize a tuning result into the trial-doc shape used by the run.

    Matches KB's per-trial shape so the shared TrialsTable can render it:
    {trial_id, config, score, lift_vs_default, tokens_used, status,
     duration_seconds, started_at}.
    """
    score_unit = _score_to_unit(result.get("score"))
    lift = None
    if score_unit is not None and baseline_default_score is not None:
        lift = round(score_unit - baseline_default_score, 4)

    status = "failed" if result.get("error") else "completed"
    cfg = _trial_config_for_run(result)

    return {
        "trial_id": result.get("label", ""),
        "config": cfg,
        "score": score_unit,
        "accuracy": result.get("accuracy"),
        "consistency": result.get("consistency"),
        "lift_vs_default": lift,
        "tokens_used": 0,  # not yet measured — Phase 1B
        "status": status,
        "duration_seconds": result.get("elapsed_seconds"),
        "error": result.get("error"),
    }


async def _apply_best(ss: SearchSet | None, run_doc: ExtractionOptimizationRun) -> None:
    if ss is None or not run_doc.best_config:
        return
    run_doc.previous_override = ss.extraction_config_override
    ss.extraction_config_override = run_doc.best_config
    ss.extraction_config_override_set_at = datetime.datetime.now(tz=datetime.timezone.utc)
    await ss.save()


async def get_active_run(search_set_uuid: str) -> ExtractionOptimizationRun | None:
    """Return the most-recent non-terminal run for this SearchSet, if any.

    Used by the UI on mount to detect "is something already running?" so it
    can polling-resume rather than start a fresh one.
    """
    return await ExtractionOptimizationRun.find_one(
        {
            "search_set_uuid": search_set_uuid,
            "status": {"$in": ["queued", "running"]},
        },
        sort=[("started_at", -1)],
    )


# ---------------------------------------------------------------------------
# Recommendations engine
#
# Generates actionable per-field suggestions from the winning trial's
# field_breakdown plus the run-level baselines. Each suggestion has the same
# shape as KB's data_source_suggestions so the shared SuggestionsList renders
# them without per-domain branching.
# ---------------------------------------------------------------------------


# Accuracy below this in the winning config means the optimizer couldn't
# reliably extract the field — the user needs to rewrite the field's
# definition or add hints, not just tune the engine knobs.
WEAK_FIELD_ACCURACY_THRESHOLD = 0.5

# Consistency below this means the field is unstable across runs — adding
# few-shot examples or pinning the model temperature would help.
UNSTABLE_FIELD_CONSISTENCY_THRESHOLD = 0.6

# Workflow shortcut: when the no-tool baseline ≈ the optimized score, the
# extraction tool isn't earning its complexity. Surface this only when both
# scores are decent enough that the user might consider simplifying.
REDUNDANT_TOOL_LIFT_THRESHOLD = 0.05
REDUNDANT_TOOL_MIN_SCORE = 0.7


def _generate_suggestions(
    *,
    field_breakdown: list[dict],
    baseline_no_tool: float | None,
    baseline_default: float | None,
    optimized: float | None,
) -> list[dict]:
    """Produce ranked suggestion dicts for the run.

    Shape mirrors KB's data_source_suggestions for shared-component reuse:
        {kind, severity, message, [field]}

    Each suggestion is independent — the UI renders them in order. Critical
    first, then warnings, then info.
    """
    suggestions: list[dict] = []

    for field in field_breakdown:
        name = field.get("field", "")
        accuracy = field.get("accuracy")
        consistency = field.get("consistency")
        if not name or accuracy is None:
            continue

        if accuracy < WEAK_FIELD_ACCURACY_THRESHOLD:
            suggestions.append({
                "kind": "weak_field",
                "severity": "critical" if accuracy < 0.3 else "warning",
                "field": name,
                "message": (
                    f'Field "{name}" was only right {int(accuracy * 100)}% of the time, even with '
                    "the best settings we tried. Try rewriting its description to be more specific, "
                    "adding example values, or marking it optional if it isn't always present."
                ),
            })
            continue  # Weak fields skip the unstable check (the priority signal is accuracy)

        if consistency is not None and consistency < UNSTABLE_FIELD_CONSISTENCY_THRESHOLD:
            suggestions.append({
                "kind": "unstable_field",
                "severity": "warning",
                "field": name,
                "message": (
                    f'Field "{name}" gave different answers on different runs '
                    f"(matched only {int(consistency * 100)}% of the time). Adding 1–2 example "
                    "values to its description usually helps the AI pick the same answer each time."
                ),
            })

    # Run-level: is the extraction tool earning its complexity?
    if (
        baseline_no_tool is not None
        and optimized is not None
        and optimized >= REDUNDANT_TOOL_MIN_SCORE
        and (optimized - baseline_no_tool) < REDUNDANT_TOOL_LIFT_THRESHOLD
    ):
        suggestions.append({
            "kind": "redundant_tool",
            "severity": "info",
            "message": (
                f"Even with no custom settings at all, the AI already scored "
                f"{int(baseline_no_tool * 100)}% — about the same as the optimized "
                f"settings ({int(optimized * 100)}%). For this kind of data, you may not "
                "need to fine-tune these settings."
            ),
        })

    # Run-level: did the optimizer actually beat the user's existing config?
    if (
        baseline_default is not None
        and optimized is not None
        and (optimized - baseline_default) < 0.02
        and baseline_default >= 0.7
    ):
        suggestions.append({
            "kind": "already_good",
            "severity": "info",
            "message": (
                f"Your current settings already scored {int(baseline_default * 100)}% — "
                "the optimizer barely found anything to improve. Your settings are in good shape."
            ),
        })

    # Stable ordering: critical → warning → info; preserve insertion order within tier.
    severity_rank = {"critical": 0, "warning": 1, "info": 2}
    suggestions.sort(key=lambda s: severity_rank.get(s.get("severity", "info"), 99))
    return suggestions
