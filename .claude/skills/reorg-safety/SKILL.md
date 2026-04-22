---
name: reorg-safety
description: Reorg-safe staging, commitment promotion, and rollback rules for SolObserve. Invoke when writing or modifying ingestor commitment handling, decoder commitment_promotions/rollbacks logic, alerter commitment-aware rules, or any query that aggregates over slot-recent data. Also invoke when adding a new commitment-sensitive surface.
---

# Reorg & commitment safety

## States

| Commitment  | Where it lands                                                | When                                 |
| ----------- | ------------------------------------------------------------- | ------------------------------------ |
| `processed` | NATS `RAW_TX` + ClickHouse base tables (live but provisional) | first sight                          |
| `confirmed` | `commitment_promotions` row                                   | promoted (default surface threshold) |
| `finalized` | `commitment_promotions` row                                   | promoted further                     |

## Promotion rules (ingestor)

- Subscribe at `processed` for primary stream.
- Drive promotion via either:
  - Separate `logsSubscribe` at `confirmed` (if endpoint supports per-commitment subscription), OR
  - `getSignatureStatuses` poll for the recent-sigs LRU.
- Publish `RawTxMsg` with `commitment="processed"` immediately. Publish promotion message on confirmation.
- Reorg window: default 32 slots. If a `processed` signature is NOT seen at `confirmed` within window → publish `rollback(signature)`.

## Decoder behavior

- On `processed` message: insert decoded rows.
- On `confirmed` promotion: insert into `commitment_promotions(signature, commitment='confirmed', observed_at)`. NEVER `ALTER UPDATE` base tables.
- On `finalized` promotion: same pattern.
- On rollback: insert into `rollbacks(signature, slot, observed_at)`.

## Query layer invariant

Every query must:

1. Filter `WHERE signature NOT IN (SELECT signature FROM rollbacks WHERE program_id=?)`.
2. Optionally left-join `commitment_promotions` to read effective commitment.

Wrap both in a single helper. Never reimplement inline.

## Alert layer

- Default rule mode: `confirmed` data only. Skip `processed`-only rows.
- Optional `finalized` mode for high-stakes rules.
- Acceptance: no false-positive alert from a `processed`-only row that subsequently gets reorged out.

## UI

- Tag every metric chart with effective commitment in tooltip.
- Reorg dashboard (per FRD §F19): frequency, avg depth, programs affected. Reads from `rollbacks` + ingestor metrics.

## Idempotency

- Same `(signature)` processed twice MUST produce same output. Decoder uses signature LRU + ClickHouse `ReplacingMergeTree` on `transactions`.
- One `processed` message + at most one `confirmed` + at most one `finalized` per signature. Enforce via dedup keys in NATS deliveries.

## Tests

- Reorg of depth ≤ 2: no false alerts, no data corruption.
- Re-publishing same `processed` message twice: identical state.
- `finalized` arriving without prior `confirmed`: still recorded correctly.
- Rolled-back signature excluded from queries within 1s of rollback message.
