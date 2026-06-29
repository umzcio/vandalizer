"""Tests for anonymous deployment telemetry — sender service + receiver routes.

Follows the repo convention of mocking Beanie model methods rather than standing
up a database. Covers: bucket coarsening, payload assembly + the voluntary
identity tier, the send-side opt-in interlocks, ingest validation/upsert, and
the admin analytics aggregation + access gate.
"""

import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.routers import telemetry as rx
from app.services import telemetry_service as tx


@pytest.fixture(autouse=True)
def _disable_rate_limiter():
    """Unit-test the ingest handler directly; slowapi's decorator otherwise
    demands a real starlette Request. Restored after each test."""
    prev = rx.limiter.enabled
    rx.limiter.enabled = False
    yield
    rx.limiter.enabled = prev


# ---------------------------------------------------------------------------
# Fake sync DB for the sender's build_heartbeat_payload / instance id
# ---------------------------------------------------------------------------


class _FakeColl:
    def __init__(self, count, state):
        self._count = count
        self._state = state

    def count_documents(self, _q):
        return self._count

    def find_one(self, _q):
        return self._state

    def update_one(self, *_a, **_k):
        return None


class _FakeDB:
    """Returns a per-collection document count; serves a fixed instance id."""

    def __init__(self, counts):
        self._counts = counts
        self._state = {"instance_id": "fixed-instance-id"}

    def __getitem__(self, name):
        return _FakeColl(self._counts.get(name, 0), self._state)


# ---------------------------------------------------------------------------
# Bucketing
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "n,expected",
    [
        (0, "0"), (-5, "0"), (1, "1"), (2, "2-10"), (10, "2-10"),
        (11, "11-50"), (50, "11-50"), (51, "51-200"), (200, "51-200"),
        (201, "201-1000"), (1000, "201-1000"), (1001, "1000+"), (99999, "1000+"),
    ],
)
def test_bucket_boundaries(n, expected):
    assert tx._bucket(n) == expected


def test_coarse_environment_only_prod_or_other():
    assert tx._coarse_environment(Settings(environment="production")) == "production"
    assert tx._coarse_environment(Settings(environment="staging")) == "other"
    assert tx._coarse_environment(Settings(environment="development")) == "other"


# ---------------------------------------------------------------------------
# Payload assembly + voluntary identity tier
# ---------------------------------------------------------------------------


def _counts(**kw):
    base = {"user": 0, "team": 0, "smart_document": 0, "workflow": 0}
    base.update(kw)
    return base


def test_payload_buckets_and_shape():
    db = _FakeDB(_counts(user=30, team=3, smart_document=120, workflow=7))
    p = tx.build_heartbeat_payload(db, Settings(telemetry_enabled=True))
    assert p["schema"] == 1
    assert p["instance_id"] == "fixed-instance-id"
    assert p["metrics"] == {
        "users": "11-50",
        "active_users_30d": "11-50",
        "teams": "2-10",
        "documents": "51-200",
        "workflows": "2-10",
    }


def test_payload_anonymous_when_no_org():
    db = _FakeDB(_counts(user=1))
    p = tx.build_heartbeat_payload(db, Settings(telemetry_enabled=True))
    assert "identity" not in p


def test_payload_includes_identity_when_org_set():
    db = _FakeDB(_counts(user=1))
    s = Settings(
        telemetry_enabled=True,
        telemetry_organization="University of Idaho",
        telemetry_contact_email="ra@uidaho.edu",
    )
    p = tx.build_heartbeat_payload(db, s)
    assert p["identity"] == {
        "organization": "University of Idaho",
        "contact_email": "ra@uidaho.edu",
    }


def test_payload_email_without_org_stays_anonymous():
    """contact_email must never leak without a deliberate org declaration."""
    db = _FakeDB(_counts(user=1))
    s = Settings(telemetry_enabled=True, telemetry_contact_email="ra@uidaho.edu")
    assert "identity" not in tx.build_heartbeat_payload(db, s)


# ---------------------------------------------------------------------------
# Send-side opt-in interlocks
# ---------------------------------------------------------------------------


def test_send_noop_when_disabled():
    assert tx.send_heartbeat(_FakeDB(_counts()), Settings(telemetry_enabled=False)) == {
        "status": "disabled"
    }


def test_send_requires_endpoint():
    s = Settings(telemetry_enabled=True, telemetry_endpoint="")
    assert tx.send_heartbeat(_FakeDB(_counts()), s)["status"] == "no_endpoint"


def test_send_posts_payload_when_configured():
    db = _FakeDB(_counts(user=5))
    s = Settings(telemetry_enabled=True, telemetry_endpoint="https://collector.example/hb")

    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_client = MagicMock()
    mock_client.__enter__ = MagicMock(return_value=mock_client)
    mock_client.__exit__ = MagicMock(return_value=False)
    mock_client.post = MagicMock(return_value=mock_resp)

    with patch.object(tx.httpx, "Client", return_value=mock_client):
        result = tx.send_heartbeat(db, s)

    assert result["status"] == "sent"
    _, kwargs = mock_client.post.call_args
    assert kwargs["json"]["metrics"]["users"] == "2-10"


# ---------------------------------------------------------------------------
# Ingest payload validation
# ---------------------------------------------------------------------------


def test_ingest_parses_client_shape_and_ignores_extra():
    p = rx.HeartbeatIn.model_validate({
        "schema": 1,
        "instance_id": "abcd1234ef",
        "version": "v2026.04.1",
        "environment": "production",
        "metrics": {"users": "11-50"},
        "identity": {"organization": "U of Idaho"},
        "future_field": "ignored",
    })
    assert p.instance_id == "abcd1234ef"
    assert p.identity.organization == "U of Idaho"


def test_ingest_identity_optional():
    p = rx.HeartbeatIn.model_validate({"schema": 1, "instance_id": "abcd1234ef"})
    assert p.identity is None
    assert p.environment == "other"


def test_ingest_rejects_short_instance_id():
    with pytest.raises(ValidationError):
        rx.HeartbeatIn.model_validate({"instance_id": "short"})


def test_ingest_rejects_oversized_strings():
    with pytest.raises(ValidationError):
        rx.HeartbeatIn.model_validate({"instance_id": "abcd1234ef", "version": "v" * 100})


# ---------------------------------------------------------------------------
# Ingest upsert behavior
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ingest_inserts_new_instance():
    payload = rx.HeartbeatIn.model_validate({
        "schema": 1, "instance_id": "new-instance-id", "version": "v1.0.0",
        "environment": "production", "metrics": {"users": "2-10"},
    })
    created = MagicMock()
    created.insert = AsyncMock()
    with patch.object(rx, "TelemetryHeartbeat") as Model:
        Model.find_one = AsyncMock(return_value=None)
        Model.return_value = created
        out = await rx.receive_heartbeat(MagicMock(), payload)
    assert out == {"status": "ok"}
    created.insert.assert_awaited_once()


@pytest.mark.asyncio
async def test_ingest_updates_existing_and_increments_count():
    payload = rx.HeartbeatIn.model_validate({
        "schema": 1, "instance_id": "known-id", "version": "v2.0.0",
        "environment": "weird-value", "metrics": {"users": "51-200"},
        "identity": {"organization": "  Boise State  ", "contact_email": "x@bsu.edu"},
    })
    existing = MagicMock()
    existing.heartbeat_count = 4
    existing.save = AsyncMock()
    with patch.object(rx, "TelemetryHeartbeat") as Model:
        Model.find_one = AsyncMock(return_value=existing)
        await rx.receive_heartbeat(MagicMock(), payload)

    existing.save.assert_awaited_once()
    assert existing.heartbeat_count == 5
    assert existing.version == "v2.0.0"
    # Unknown environment collapses to "other"; org is trimmed.
    assert existing.environment == "other"
    assert existing.organization == "Boise State"
    assert existing.contact_email == "x@bsu.edu"


# ---------------------------------------------------------------------------
# Analytics aggregation + access gate
# ---------------------------------------------------------------------------


def test_tally_counts_and_defaults_unknown():
    assert rx._tally(["a", "a", "b", ""]) == {"a": 2, "b": 1, "unknown": 1}


def _row(version, env, users, org, days_ago):
    last_seen = rx._utcnow() - datetime.timedelta(days=days_ago)
    return SimpleNamespace(
        version=version, environment=env, metrics={"users": users},
        organization=org, last_seen=last_seen,
    )


@pytest.mark.asyncio
async def test_analytics_requires_admin():
    non_admin = SimpleNamespace(is_admin=False, is_staff=False)
    with pytest.raises(rx.HTTPException) as exc:
        await rx.telemetry_analytics(user=non_admin)
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_analytics_aggregates_active_named_and_anonymous():
    rows = [
        _row("v1", "production", "2-10", "U of Idaho", days_ago=1),    # active, named
        _row("v1", "other", "11-50", None, days_ago=5),               # active, anon
        _row("v2", "production", "2-10", "Stale U", days_ago=99),     # inactive, named
    ]
    admin = SimpleNamespace(is_admin=True, is_staff=False)
    with patch.object(rx, "TelemetryHeartbeat") as Model:
        Model.find_all = MagicMock(
            return_value=MagicMock(to_list=AsyncMock(return_value=rows))
        )
        out = await rx.telemetry_analytics(user=admin)

    assert out["total_instances"] == 3
    assert out["active_instances_30d"] == 2
    assert out["named_instances"] == 2          # counts named regardless of active
    assert out["anonymous_instances"] == 1
    # Distributions are computed over ACTIVE rows only.
    assert out["by_version"] == {"v1": 2}
    assert out["by_environment"] == {"production": 1, "other": 1}
    assert out["users_buckets"] == {"2-10": 1, "11-50": 1}
    # Named list is sorted most-recent first and carries the active flag.
    assert [d["organization"] for d in out["named_deployments"]] == ["U of Idaho", "Stale U"]
    assert out["named_deployments"][0]["active"] is True
    assert out["named_deployments"][1]["active"] is False
