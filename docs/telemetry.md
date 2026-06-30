# Telemetry

Vandalizer can send the maintainers an **anonymous, opt-in heartbeat** so we can
see how many deployments exist and roughly how heavily they're used. This page is
the full disclosure: exactly what is sent, what is never sent, and how to turn it
on, off, or point it at your own collector.

**It is off by default.** A fresh install sends nothing. Telemetry only happens
after an administrator explicitly enables it (the `./setup.sh` installer asks,
defaulting to *no*).

## What is sent

When enabled, one HTTP `POST` is sent once per day with a payload of this exact
shape:

```json
{
  "schema": 1,
  "instance_id": "8f3c1e2a-...-random-uuid",
  "version": "v2026.06.1",
  "environment": "production",
  "sent_at": "2026-06-29T07:23:00+00:00",
  "metrics": {
    "users": "11-50",
    "active_users_30d": "11-50",
    "teams": "2-10",
    "documents": "51-200",
    "workflows": "2-10"
  }
}
```

- **`instance_id`** — a random UUID generated locally on first heartbeat and
  stored in your own database. It identifies the *install*, not you; it is not
  derived from anything about your institution and cannot be reversed.
- **`version`** / **`environment`** — the running version, and a coarse
  `production` vs. `other` only (never your `DEPLOYMENT_LABEL` or hostname).
- **`metrics`** — usage as **coarse buckets** (`"11-50"`), never exact counts.

## What is never sent

Document content or filenames, titles, user names or emails, team or
organization names, API keys, IP-derived identity, or any free text. The payload
is a fixed, validated shape — there is no field in which such data could ride
along.

Every heartbeat is also written to your own application log before it is sent
(`TELEMETRY_LOG_PAYLOAD=true`, the default), so an administrator can read the
literal bytes that left the box.

## Optional: identify your deployment

By default the heartbeat is fully anonymous. If you *want* the maintainers to
know who you are — for adoption reporting, or to receive security advisories —
you can voluntarily attach your organization name:

```bash
TELEMETRY_ORGANIZATION="University of Idaho"
TELEMETRY_CONTACT_EMAIL="research-admin@uidaho.edu"   # optional
```

The installer offers this as a separate, explicit choice (also defaulting to
*stay anonymous*). Rules:

- It is **self-declared only**. Vandalizer never infers your identity from email
  domains, IP geolocation, or anything else.
- If `TELEMETRY_ORGANIZATION` is blank, **no identity block is sent at all** —
  not even an empty one. A contact email alone is never transmitted without an
  organization.

## Enabling, disabling, and self-hosting

All configuration is via environment variables (`backend/.env`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELEMETRY_ENABLED` | `false` | Master opt-in switch for the heartbeat. |
| `TELEMETRY_ENDPOINT` | _(empty)_ | Where heartbeats are sent. Inert unless set. |
| `TELEMETRY_LOG_PAYLOAD` | `true` | Log each payload locally before sending. |
| `TELEMETRY_ORGANIZATION` | _(empty)_ | Optional self-declared identity. |
| `TELEMETRY_CONTACT_EMAIL` | _(empty)_ | Optional contact, sent only with an org. |

The heartbeat is **inert unless both `TELEMETRY_ENABLED=true` and
`TELEMETRY_ENDPOINT` are set**, so flipping the switch alone never sends data to
a guessed destination.

- **To disable:** set `TELEMETRY_ENABLED=false` (or leave it). Takes effect on
  the next worker restart.
- **To send to your own collector instead:** point `TELEMETRY_ENDPOINT` at any
  URL that accepts the JSON above — including your own Vandalizer instance acting
  as a collector (see below).

## Running your own collector

Any Vandalizer deployment can act as the receiver by setting:

```bash
TELEMETRY_COLLECTOR_ENABLED=true
```

This — and only this — exposes the public `POST /api/telemetry/heartbeat` ingest
route and an admin **Telemetry** dashboard (fleet size, version distribution,
active deployments, and any self-declared organizations). On every deployment
where the flag is unset, both the route and the dashboard do not exist at all.

The ingest endpoint is unauthenticated by design (heartbeats arrive from
deployments with no shared secret), and is rate-limited and strictly validated.
Received data is stored in a dedicated `telemetry_heartbeat` collection, kept
separate from any operational or document data.
