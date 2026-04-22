---
name: solobserve-dsl
description: Pinned grammar and compiler rules for the SolObserve PromQL-inspired query DSL. Invoke when writing or modifying crates/solobserve-dsl, the API gateway query route, the dashboard panel editor, the alerter rule evaluator, or any code that emits or consumes DSL strings. Also invoke when adding a new metric, function, or label.
---

# SolObserve DSL

PromQL-inspired. Compiles to ClickHouse SQL. Single grammar — same DSL drives panels, alerts, NL→DSL output, and the saved-search advanced mode.

## Grammar (canonical)

```
expr        := vector | scalar | binary | aggregation | function_call
vector      := metric_name selector? range?
selector    := '{' label_match (',' label_match)* '}'
label_match := IDENT op (STRING | REGEX)
op          := '=' | '!=' | '=~' | '!~'
range       := '[' DURATION ']'        # 5m, 1h, 1d, 30s
binary      := expr ('+'|'-'|'*'|'/') expr
aggregation := agg_op ('by'|'without' '(' IDENT (',' IDENT)* ')')? '(' expr ')'
agg_op      := 'sum' | 'avg' | 'min' | 'max' | 'count' | 'topk' | 'bottomk'
function_call := IDENT '(' arg (',' arg)* ')'
```

Functions: `rate`, `irate`, `increase`, `histogram_quantile`, `topk`, `bottomk`, plus aggregations.

Event predicate form: `event{type="TradeExecuted", payload.amount > 1000000000}`. Nested-path operators: `>, <, >=, <=, ==, !=`. Compiles to `JSONExtract*` against `events.payload_json`.

## Compiler invariants

- Always inject `program_id = $program_id` and `cluster = $cluster`. No exceptions.
- Always exclude rolled-back signatures.
- Resolve metric name → ClickHouse table. Prefer materialized view; fall back to base table.
- Time bucketing from `[range]` OR from query body's `step`. Default step from window: 30s for ≤1h, 1m for ≤24h, 5m for ≤7d, 1h for >7d.
- Parameterized SQL only.
- Output shape: `QueryResult { series: [{ labels: Map, points: [(t, v)] }] }`.

## Errors

- Parser errors carry line + column. UI surfaces them in the editor.
- Unknown metric → 400 with the catalog hint.
- Unknown label → 400 with available labels for that metric.

## NL → DSL

- Model: Claude Haiku via Anthropic SDK.
- System prompt includes catalog (metric names + labels for THIS program) + grammar summary + golden examples.
- Always returns `{ dsl, explanation, confidence }`. UI shows DSL before running.
- Optional feature — gracefully 503 when no Anthropic key configured.

## Tests required

- Golden parse trees for ≥40 queries.
- Golden compiled SQL for the same set.
- Tenancy: cross-program query rejected.
- Round-trip: NL → DSL → SQL → result for committed example set (snapshot mode in CI).

## Hard rules

- No raw SQL injection path except `/v1/programs/:id/query/raw_sql` (admin-only).
- DSL is the single grammar. Do not invent a parallel grammar for alerts, panels, or NL output.
