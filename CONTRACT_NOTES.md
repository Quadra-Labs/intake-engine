# Intake engine — on-chain contract notes

These are notes for the **off-chain** intake engine. The Move side lives in
[`contracts/sources/intake.move`](../contracts/sources/intake.move). No code goes
in this folder — just how the engine talks to the contract.

## Flow

```
User  ──requests job──▶  Agent
Agent ──{ user, job_id, agent_wallet, cost }──▶  Intake engine        (off-chain)
Intake engine checks its memory for that exact record.
  If present, it returns a session to the agent:
        { session_id, job_id, agent_wallet, cost }                    (off-chain)
Agent ──forwards session──▶  User
User  ──signs a contract call: pay_for_job(...)──▶  Quadra contract   (ON-CHAIN)
Contract locks `cost` $QUADRA in an Escrow and emits `JobPaid`.
Intake engine watches for `JobPaid` and matches it to the session.   (event)

  ── delivered ──▶  Intake engine ──release_payment(IntakeCap, ...)──▶ contract
                    Contract pays agent_wallet (cost − fee); fee → treasury.

  ── NOT delivered after 30 min ──▶
        Intake engine ──refund_not_delivered(IntakeCap, ...)──▶ contract
        Contract refunds `cost` to the user and emits `JobNotDelivered`
        with agent_score = 0. The intake engine / data layer then:
          • records the 0 in the agent score DB (Walrus), and
          • appends the job to the **non-delivered jobs** list on Walrus
            (via the data layer).
```

The off-chain "agent signs a random key" handshake stays off-chain. On-chain, both
release and refund are gated purely by the `IntakeCap`, so only the intake engine
can move escrowed funds. The 30-minute wait is enforced on-chain against the
`paid_at_ms` stored on the escrow (via the `Clock`).

## The stored object (what the contract keeps after the user pays)

`pay_for_job` wraps the payment into a shared `Escrow` object — this is the
on-chain form of the session:

| Field          | Type              | Notes                                             |
| -------------- | ----------------- | ------------------------------------------------- |
| `session_id`   | `String`          | the intake engine's session id                    |
| `job_id`       | `String`          | the job being paid for                            |
| `agent_wallet` | `address`         | payee; must be a **registered** agent             |
| `funds`        | `Balance<QUADRA>` | the locked `cost`                                 |
| `user`         | `address`         | the payer; refunded if the job isn't delivered    |
| `paid_at_ms`   | `u64`             | payment time; the 30-min refund clock starts here |

`pay_for_job` **aborts if `agent_wallet` is not registered** — a user can never
pay an unregistered agent.

## Events to watch

- **`JobPaid`** `{ escrow_id, session_id, job_id, agent_wallet, cost, paid_at_ms }`
  — emitted on every `pay_for_job`. Match `session_id`/`job_id` to your memory,
  then keep `escrow_id` (you need it to release or refund). `paid_at_ms` tells you
  when the 30-minute refund window opens (`paid_at_ms + 30min`).
- **`PaymentReleased`** `{ escrow_id, agent_wallet, agent_amount, fee }`
- **`JobNotDelivered`** `{ escrow_id, job_id, agent_wallet, user, refund_amount, agent_score }`
  — `agent_score` is always `0`. The data layer records this 0 in the agent score
  DB and appends the job to the non-delivered jobs list (both on Walrus).

## Functions the engine cares about

- `pay_for_job(registry, access_registry, session_id, job_id, agent_wallet, payment, clock, ctx)`
  — called by the **user** (public). Pass the `Clock` (`0x6`).
- `release_payment(&IntakeCap, &IntakeConfig, escrow, ctx)` — called by the
  **intake engine** on delivery. Pays `agent_wallet` the cost minus the fee.
- `refund_not_delivered(&IntakeCap, escrow, clock, ctx)` — called by the
  **intake engine** when the job was not delivered. Aborts (`ETooEarly`) before
  `paid_at_ms + 30min`. Refunds the user and emits `JobNotDelivered` (agent → 0).
- `set_fee(&IntakeCap, &mut IntakeConfig, fee_bps, treasury)` — change the cut
  and the fee recipient.

## The fee (the "percentage cut")

Stored in the shared `IntakeConfig` object as `fee_bps` (basis points; 10000 =
100%). **Default at publish: 1000 = 10%.** On `release_payment`:

```
fee          = cost * fee_bps / 10000      (treasury gets this)
agent_amount = cost - fee                   (agent_wallet gets this)
```

Change it any time with `set_fee` (intake engine holds the `IntakeCap`).

## Capability custody

At publish, the deployer receives `IntakeCap`. Transfer it to the intake
engine's wallet so that wallet — and only it — can release/refund/set-fee:

```
sui client transfer --object-id <IntakeCap> --to <intake-engine-wallet>
```
