-- Plan 13: ClickHouse MVs + tables for funnel + adjacency + RPC health.

ALTER TABLE events ADD COLUMN IF NOT EXISTS signer String DEFAULT '';
ALTER TABLE instructions ADD COLUMN IF NOT EXISTS signer String DEFAULT '';

-- Per-minute signer→event index used to scan adjacent slots cheaply for the
-- sandwich/front-run detector. The base events table is already partitioned
-- by month; we summarize one row per (signer, minute, program, event_name)
-- so scans of "recent N slots around X" stay small.
CREATE MATERIALIZED VIEW IF NOT EXISTS signer_events_minute
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (cluster, program_id, signer, bucket)
AS
SELECT
    toStartOfMinute(block_time) AS bucket,
    cluster,
    program_id,
    signer,
    event_name,
    count() AS events
FROM events
GROUP BY bucket, cluster, program_id, signer, event_name;

-- Per-(signer, instruction) index for fast funnel/cohort queries. Stores one
-- row per signer/instruction with first + most-recent occurrence; the funnel
-- API does `windowFunnel` over this rolled table for the 5-step / 100k
-- signer < 5 s target.
CREATE MATERIALIZED VIEW IF NOT EXISTS signer_instruction_events
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(min_time)
ORDER BY (cluster, program_id, signer, instruction_name)
AS
SELECT
    cluster,
    program_id,
    signer,
    instruction_name,
    min(block_time) AS min_time,
    max(block_time) AS max_time,
    count() AS calls
FROM instructions
WHERE status = 'success'
GROUP BY cluster, program_id, signer, instruction_name;

CREATE TABLE IF NOT EXISTS rpc_health (
    cluster        LowCardinality(String),
    endpoint_hash  LowCardinality(String),
    endpoint_label LowCardinality(String),
    ts             DateTime,
    latency_ms     UInt32,
    success        UInt8,
    slot_lag       Int64,
    error_kind     LowCardinality(String) DEFAULT ''
) ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (cluster, endpoint_hash, ts)
SETTINGS index_granularity = 8192;
