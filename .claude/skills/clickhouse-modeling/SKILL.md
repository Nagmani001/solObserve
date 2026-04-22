---
name: clickhouse-modeling
description: ClickHouse schema, table-engine, materialized-view, and query rules for SolObserve. Invoke when writing or modifying any ClickHouse migration, materialized view, or query in services/decoder, services/api-gateway query layer, crates/solobserve-dsl compiler, or crates/solobserve-storage. Also invoke when adding a new metric, debugging slow queries, or sizing partitions.
---

# ClickHouse modeling rules

## Engines

| Table                   | Engine                                                                | Reason                                            |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| `transactions`          | `ReplacingMergeTree(slot)` ORDER BY `(program_id, slot, signature)`   | dedupe on retry, latest slot wins                 |
| `instructions`          | `MergeTree` ORDER BY `(program_id, slot, signature, ix_index)`        | append-only                                       |
| `events`                | `MergeTree` ORDER BY `(program_id, event_type, slot)`                 | append-only, queries usually filter by event_type |
| `account_writes`        | `MergeTree` ORDER BY `(program_id, account, slot)`                    | per-account scrub                                 |
| `cpi_edges`             | `MergeTree` ORDER BY `(program_id, slot, signature, parent_ix_index)` | trace queries                                     |
| `tx_logs`               | `MergeTree` + `tokenbf_v1` index on `log_lines_concat`                | full-text search                                  |
| `metrics_*` MVs         | `AggregatingMergeTree` with `*State` aggregate columns                | pre-aggregated                                    |
| `commitment_promotions` | `MergeTree` ORDER BY `(signature)`                                    | left-joined to base tables                        |
| `rollbacks`             | `MergeTree` ORDER BY `(signature)`                                    | NOT IN filter                                     |
| `spans`                 | `MergeTree` ORDER BY `(program_id, signature, span_id)`               | SDK spans                                         |

## Partition

`PARTITION BY toYYYYMM(block_time)` on every transaction-derived table. Drops are partition-level later.

## Aggregates

- Histograms: `quantilesTDigestState(...)` — supports arbitrary quantile at query time via `quantilesTDigestMerge`.
- Unique signers: `uniqHLL12State(signer)` per (program, instruction, hour). Merge at query time.
- Never use `quantileExact` over full table — too slow.

## Async inserts

Decoder uses ClickHouse async insert: batch 500 rows / 200 ms. Configure `async_insert=1, wait_for_async_insert=1` on the client.

## Query rules

- ALWAYS inject `program_id = ?` and `cluster = ?` filters — tenancy boundary.
- ALWAYS exclude rolled-back signatures: `WHERE signature NOT IN (SELECT signature FROM rollbacks WHERE program_id = ?)`. Wrap in helper.
- Left-join `commitment_promotions` to read effective commitment.
- For `ReplacingMergeTree`, use `FINAL` only when correctness requires; prefer GROUP BY + argMax for hot paths.
- Parameterized queries only. Never string-concat user input into SQL.

## Performance targets (FRD)

- Dashboard query p95 < 1.5 s, p99 < 5 s.
- 1B-row table query for single program/instruction < 500 ms.
- 30-day full-text search < 3 s p95.
- 5-step funnel over 100k signers < 5 s.

## Migrations

- SQL files under `crates/solobserve-storage/clickhouse-migrations/`. Numeric prefix.
- Tracked in `_migrations` table. Idempotent — re-running noop.
- Never `ALTER TABLE ... UPDATE` on hot tables. Use side tables (`commitment_promotions`, `rollbacks`).
