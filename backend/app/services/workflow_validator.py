"""Validation helpers — shared LLM-output parsing + model resolution.

This module previously contained a full Flask-port plan generator + check
runner + scorer (PlanGenerator / CheckRunner / Scorer), but those were
superseded by the user-facing validation flow in :mod:`app.services.workflow_service`
(``generate_validation_plan``, ``_evaluate_checks_against_output``,
``_build_result``). The Flask port had no remaining callers and was deleted.

What remains here are the two small synchronous helpers that several KB /
extraction / workflow modules still depend on:

* ``_extract_json`` — strip markdown fences and pull a JSON object/list out
  of free-form LLM output.
* ``_resolve_model_name`` — synchronous (pymongo) lookup of the user's
  configured model name, with a system-default fallback. Used by Celery
  workers and other sync code paths where the async ``get_user_model_name``
  isn't available.

Both helpers are unchanged from the original Flask port so existing import
sites continue to work without edits.
"""

from __future__ import annotations

import json
import logging
import re

logger = logging.getLogger(__name__)

__all__ = ["_extract_json", "_resolve_model_name"]


def _get_db():
    from app.tasks import get_sync_db

    return get_sync_db()


def _resolve_model_name(user_id: str | None = None) -> str:
    """Resolve model name using user config, falling back to system default.

    Synchronous (pymongo). Returns "" when no model can be resolved — callers
    should treat that as "no LLM configured" and skip or raise as appropriate.

    A user's stored selection is validated against ``available_models`` (by
    name or tag) and the canonical name is returned. If the selection is stale
    — the model was removed/renamed in System Config since the user last picked
    it — we fall back to the system default instead of returning the dead name.
    Returning a name absent from ``available_models`` would leave
    ``get_agent_model`` with no endpoint/api_key for it, so it routes to the
    provider's public default host (e.g. api.openai.com), which sealed
    deployments can't reach — surfacing as a per-user "Connection error." This
    mirrors the async ``resolve_model_name`` reconciliation, which only runs
    when the user opens Settings.
    """
    db = _get_db()
    sys_cfg = db.system_config.find_one() or {}
    available = [m for m in sys_cfg.get("available_models", []) if isinstance(m, dict)]

    if user_id:
        user_config = db.user_model_config.find_one({"user_id": user_id})
        chosen = user_config.get("name") if user_config else None
        if chosen:
            for m in available:
                if m.get("name") == chosen or m.get("tag") == chosen:
                    return m.get("name", chosen)
            logger.warning(
                "User %s has a stale model selection %r not in available_models; "
                "falling back to system default for the LLM call.",
                user_id, chosen,
            )

    return available[0].get("name", "") if available else ""


def _extract_json(text: str) -> dict | list:
    """Extract JSON from LLM text output, handling markdown fences.

    Raises ``ValueError`` when nothing parses — callers should treat the LLM
    response as malformed.
    """
    text = text.strip()

    if text.startswith("```"):
        text = re.sub(r"^```\w*\n?", "", text)
        text = re.sub(r"\n?```$", "", text)
        text = text.strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    for i, ch in enumerate(text):
        if ch in ("{", "["):
            try:
                return json.loads(text[i:])
            except json.JSONDecodeError:
                continue

    raise ValueError(f"Could not extract JSON from LLM output: {text[:200]}")
