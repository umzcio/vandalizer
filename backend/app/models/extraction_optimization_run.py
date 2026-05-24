"""ExtractionOptimizationRun - tracks one execution of the extraction optimizer.

A single run sweeps multiple extraction configurations (model, strategy,
prompt variant, etc.) against the same test cases and records the trial
outcomes plus the winning config. The UI polls this document for live
progress and (when status=completed) the optimization results.

Schema mirrors ``KBOptimizationRun`` so the shared frontend components can
consume it with the same field names — the differences are extraction-specific
fields (``baseline_no_tool_score``, ``field_breakdown``) and the trial config
shape (model/strategy/thinking/chunking rather than RAG knobs).
"""

from __future__ import annotations

import datetime
from typing import Literal, Optional
from uuid import uuid4

from beanie import Document
from pydantic import Field


ExtractionOptimizationStatus = Literal["queued", "running", "completed", "failed", "cancelled"]


class ExtractionOptimizationRun(Document):
    """A single optimization run for an extraction (SearchSet)."""

    uuid: str = ""
    search_set_uuid: str
    user_id: str
    status: ExtractionOptimizationStatus = "queued"

    # Lifecycle timestamps
    started_at: datetime.datetime = Field(
        default_factory=lambda: datetime.datetime.now(tz=datetime.timezone.utc)
    )
    completed_at: Optional[datetime.datetime] = None

    # Budget enforcement (mirrors KBOptimizationRun)
    token_budget: int = 0
    tokens_used: int = 0
    estimated_cost_usd: Optional[float] = None
    actual_cost_usd: Optional[float] = None

    cancel_requested: bool = False

    # Live progress — UI polls these
    phase: str = "queued"
    progress_message: str = ""
    current_trial_index: int = 0
    total_trials_planned: int = 0
    best_score_so_far: Optional[float] = None
    best_config_so_far: Optional[dict] = None

    # Final results (populated when status=completed)
    # `baseline_no_tool_score`: 1-shot prompt without extraction config — the
    # "is this extraction earning its complexity?" floor.
    # `baseline_default_score`: current authored extraction_config.
    # `optimized_score`: best trial's score.
    baseline_no_tool_score: Optional[float] = None
    baseline_default_score: Optional[float] = None
    optimized_score: Optional[float] = None
    judge_variance: Optional[float] = None
    judge_model: Optional[str] = None

    best_config: Optional[dict] = None
    trials: list[dict] = Field(default_factory=list)
    # Each trial dict shape:
    # {
    #   "trial_id": str, "config": {model, strategy, thinking, ...},
    #   "score": float, "accuracy": float, "consistency": float,
    #   "lift_vs_default": float | None,
    #   "tokens_used": int, "status": "completed|early_stopped|failed",
    #   "started_at": str, "duration_seconds": float,
    # }

    # Per-field accuracy across the best trial — drives "which fields are
    # dragging the score" recommendations. Shape: list[{field, accuracy, consistency}].
    field_breakdown: list[dict] = Field(default_factory=list)

    # Per-field suggestions surfaced to the user (e.g. "rewrite this field's
    # definition", "add few-shot examples"). Same shape as KB's data_source_suggestions.
    suggestions: list[dict] = Field(default_factory=list)

    # Preserved override from before this optimization applied (when apply_on_finish
    # is true OR a later apply call fires). Powers the revert button — restoring
    # this value clears the optimizer's applied config.
    previous_override: Optional[dict] = None

    # Caller-supplied options
    options: dict = Field(default_factory=dict)
    # Shape: {"apply_on_finish": bool, "include_judge": bool, "advanced": {...}}

    error_message: Optional[str] = None

    class Settings:
        name = "extraction_optimization_runs"
        indexes = [
            "uuid",
            "search_set_uuid",
            "status",
            ("search_set_uuid", "status"),
            "started_at",
        ]

    def __init__(self, **data):
        super().__init__(**data)
        if not self.uuid:
            self.uuid = uuid4().hex
