ALTER TABLE commitment_promotions
    ADD COLUMN IF NOT EXISTS cluster LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS program_id String DEFAULT '',
    ADD COLUMN IF NOT EXISTS slot UInt64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS observed_at_ms Int64 DEFAULT toUnixTimestamp64Milli(now64(3));

ALTER TABLE rollbacks
    ADD COLUMN IF NOT EXISTS cluster LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS program_id String DEFAULT '';

CREATE TABLE IF NOT EXISTS metrics_instruction_calls_minute (
    cluster LowCardinality(String),
    program_id String,
    minute DateTime,
    instruction_name String,
    status LowCardinality(String),
    calls_state AggregateFunction(count),
    sum_cu_state AggregateFunction(sum, UInt64),
    sum_fee_state AggregateFunction(sum, UInt64),
    cu_tdigest_state AggregateFunction(quantilesTDigest(0.5, 0.9, 0.99), UInt64)
) ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(minute)
ORDER BY (cluster, program_id, instruction_name, status, minute);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_metrics_instruction_calls_minute
TO metrics_instruction_calls_minute
AS
SELECT
    i.cluster AS cluster,
    i.program_id AS program_id,
    toStartOfMinute(i.block_time) AS minute,
    i.instruction_name AS instruction_name,
    i.status AS status,
    countState() AS calls_state,
    sumState(toUInt64(t.compute_budget_consumed)) AS sum_cu_state,
    sumState(toUInt64(t.fee_lamports)) AS sum_fee_state,
    quantilesTDigestState(0.5, 0.9, 0.99)(toUInt64(t.compute_budget_consumed)) AS cu_tdigest_state
FROM instructions i
INNER JOIN transactions t
    ON t.signature = i.signature
   AND t.program_id = i.program_id
   AND t.cluster = i.cluster
GROUP BY cluster, program_id, minute, instruction_name, status;

CREATE TABLE IF NOT EXISTS metrics_errors_minute (
    cluster LowCardinality(String),
    program_id String,
    minute DateTime,
    instruction_name String,
    error_name String,
    errors_state AggregateFunction(count)
) ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(minute)
ORDER BY (cluster, program_id, instruction_name, error_name, minute);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_metrics_errors_minute
TO metrics_errors_minute
AS
SELECT
    i.cluster AS cluster,
    i.program_id AS program_id,
    toStartOfMinute(i.block_time) AS minute,
    i.instruction_name AS instruction_name,
    ifNull(t.error_name, '__unknown__') AS error_name,
    countState() AS errors_state
FROM instructions i
INNER JOIN transactions t
    ON t.signature = i.signature
   AND t.program_id = i.program_id
   AND t.cluster = i.cluster
WHERE i.status = 'failed'
GROUP BY cluster, program_id, minute, instruction_name, error_name;

CREATE TABLE IF NOT EXISTS metrics_cpi_minute (
    cluster LowCardinality(String),
    program_id String,
    minute DateTime,
    callee_program LowCardinality(String),
    calls_state AggregateFunction(count),
    cu_state AggregateFunction(sum, UInt64)
) ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(minute)
ORDER BY (cluster, program_id, callee_program, minute);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_metrics_cpi_minute
TO metrics_cpi_minute
AS
SELECT
    cluster,
    program_id,
    toStartOfMinute(block_time) AS minute,
    callee_program,
    countState() AS calls_state,
    sumState(toUInt64(cu_consumed)) AS cu_state
FROM cpi_edges
GROUP BY cluster, program_id, minute, callee_program;

CREATE TABLE IF NOT EXISTS metrics_account_balances_minute (
    cluster LowCardinality(String),
    program_id String,
    minute DateTime,
    account String,
    lamports_state AggregateFunction(argMax, UInt64, DateTime)
) ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(minute)
ORDER BY (cluster, program_id, account, minute);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_metrics_account_balances_minute
TO metrics_account_balances_minute
AS
SELECT
    cluster,
    program_id,
    toStartOfMinute(block_time) AS minute,
    account,
    argMaxState(
        toUInt64(ifNull(JSONExtractInt(decoded_json, 'lamports'), 0)),
        block_time
    ) AS lamports_state
FROM account_writes
GROUP BY cluster, program_id, minute, account;

CREATE TABLE IF NOT EXISTS metrics_signers_hll_hour (
    cluster LowCardinality(String),
    program_id String,
    hour DateTime,
    instruction_name String,
    signer_hll_state AggregateFunction(uniqHLL12, String)
) ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (cluster, program_id, instruction_name, hour);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_metrics_signers_hll_hour
TO metrics_signers_hll_hour
AS
SELECT
    i.cluster AS cluster,
    i.program_id AS program_id,
    toStartOfHour(i.block_time) AS hour,
    i.instruction_name AS instruction_name,
    uniqHLL12State(t.signer) AS signer_hll_state
FROM instructions i
INNER JOIN transactions t
    ON t.signature = i.signature
   AND t.program_id = i.program_id
   AND t.cluster = i.cluster
GROUP BY cluster, program_id, hour, instruction_name;
