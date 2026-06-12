# Quadra Intake Engine

The service between agents and the chain/data layer. It authenticates agents,
holds a proposed job until the user pays on-chain, then releases the payment on
delivery or refunds the user if the agent misses the deadline. An Express service,
sibling to the [scheduler](../scheduler) and built on the [data layer](../data).

## Flow

```
Agent ──(signed) POST /jobs { template_id, lifetime, cost }──▶ Intake
Intake mints { session_id, job_id } and holds it ~15 min (Redis) → returns the session
Agent → User → user signs pay_for_job(session_id, job_id, agent_wallet, cost) on-chain
Intake polls JobPaid → promotes to an active job with a 30-min delivery deadline
  ├─ delivered:     agent stores the sealed result (data gateway), then
  │                 (signed) POST /deliver { job_id } → intake asks the validator
  │                 engine, which has the evaluation engine check the output →
  │                 valid → release_payment (cost − fee → agent) and the job is
  │                 written to the job scheduler for scoring at lifetime end
  └─ not delivered: after 30 min → refund_not_delivered (cost → user).
                    (Scoring 0 + the delayed_failed_jobs record are the scheduler's job.)
```

The intake engine never reads the (Seal-sealed) result. Delivery validity comes from
the [validator engine](../scheduler) as the response to `POST /validate`; intake
releases only on `{ valid: true }`, then registers the job in `job_scheduler` through
the data gateway so the scheduler scores it when its lifetime ends.

`job_id` is minted at submission (it must exist when the user signs, since the
contract binds the Seal access policy to it). The 30-min wait is enforced on-chain
(`paid_at_ms` on the escrow); the engine just decides when to call refund.

## Authentication

Every agent request is signed with the agent's Sui Ed25519 key. The agent signs the
personal message `` `${ts}.${rawBody}` `` and sends:

- `x-quadra-ts`: millisecond timestamp (must be within `INTAKE_AUTH_WINDOW_MS`)
- `x-quadra-sig`: base64 signature from `signPersonalMessage`

The engine recovers the address, then confirms it is a registered agent by reading
the on-chain `agent::AgentRegistry`. Unregistered or stale → `401`.

## Endpoints

- `POST /jobs` — open a job (agent-authenticated). Body `{ template_id, lifetime, cost }`.
  Returns the session `{ session_id, job_id, agent_wallet, cost }`.
- `POST /deliver` — agent claims delivery (agent-authenticated). Body `{ job_id }`.
  Intake consults the validator and returns `{ released, reason? }`; a validator
  outage is a 502 (retry later).
- `GET /health`, `GET /status` — pending/active counts.

## Run

```bash
cd ../data && npm run build      # intake imports the quadra-data dist
cd ../intake && npm install
# needs a Redis (default redis://127.0.0.1:6379)
npm start                        # Express on INTAKE_PORT (default 5000)
```

Config comes from the shared `../data/.env` (network, pointers, `QUADRA_PACKAGE_ID`)
plus intake-only vars:

| Var                       | Default                  | Meaning                                                 |
| ------------------------- | ------------------------ | ------------------------------------------------------- |
| `INTAKE_SECRET_KEY`       | —                        | wallet that owns `IntakeCap` (signs release/refund)     |
| `INTAKE_CAP_ID`           | —                        | the `IntakeCap` object id                               |
| `INTAKE_CONFIG_ID`        | —                        | the shared `IntakeConfig` object id                     |
| `INTAKE_INTERNAL_TOKEN`   | —                        | shared secret presented to the validator's `/validate`  |
| `INTAKE_VALIDATOR_URL`    | `http://localhost:4000`  | the validator engine (the scheduler's server)           |
| `DATA_GATEWAY_URL`        | `http://localhost:8787`  | data gateway intake writes through                      |
| `ROLE_TOKEN_INTAKE`       | —                        | intake's gateway role token (may write `job_scheduler`) |
| `REDIS_URL`               | `redis://127.0.0.1:6379` | Redis connection                                        |
| `INTAKE_PORT`             | `5000`                   | HTTP port                                               |
| `INTAKE_PENDING_TTL_MS`   | `900000`                 | pending session window (15 min)                         |
| `INTAKE_JOB_TTL_MS`       | `1800000`                | delivery deadline (30 min)                              |
| `INTAKE_POLL_MS`          | `3000`                   | event-poll + deadline-scan interval                     |
| `INTAKE_AUTH_WINDOW_MS`   | `60000`                  | allowed clock skew on signed messages                   |
| `INTAKE_REFUND_BUFFER_MS` | `10000`                  | wait past the deadline before refunding                 |

After publishing the package, transfer `IntakeCap` to the `INTAKE_SECRET_KEY`
address so this service — and only it — can release/refund.

## Delivery validation

Validation lives in the scheduler's **validator engine**, not here — the intake
engine never decrypts results. On `POST /deliver`, intake calls the validator's
`POST /validate { job_id }`; the validator decrypts the sealed result with the
scheduler's Seal key and has the **evaluation engine** check the output
(`/validate` on the enclave — input checks only, no scoring), answering
`{ valid }`. Intake releases on `true` and then schedules the job's scoring;
on `false` the job is left for the 30-min refund path. `INTAKE_INTERNAL_TOKEN`
must match between the two services (keep `/validate` on a private network),
and the scheduler's key must be the address set via `job_access::set_scheduler`.

Underpaid or orphan payments (less than the agreed cost, or no matching session) are
never releasable — they're tracked only so the deadline refunds the payer.

## Test

```bash
npm run e2e      # auth always runs; store + deliver-gating run if a Redis is reachable
```

The full on-chain round-trip (real `pay_for_job` → release/refund) is exercised on
testnet against a published package — see the plan's verification section.
