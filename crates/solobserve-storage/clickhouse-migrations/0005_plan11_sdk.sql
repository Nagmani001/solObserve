-- Plan 11: SDK metrics + spans tables. See implementation_plan11.md §11.3.

CREATE TABLE IF NOT EXISTS sdk_metrics (
    cluster LowCardinality(String),
    program_id String,
    name LowCardinality(String),
    labels Map(String, String),
    value Int64,
    signature String,
    slot UInt64,
    block_time DateTime
) ENGINE = MergeTree
PARTITION BY toYYYYMM(block_time)
ORDER BY (cluster, program_id, name, slot)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS spans (
    cluster LowCardinality(String),
    program_id String,
    signature String,
    span_id UInt64,
    parent_span_id Nullable(UInt64),
    name LowCardinality(String),
    started_slot UInt64,
    ended_slot UInt64,
    started_ts DateTime,
    ended_ts DateTime,
    status LowCardinality(String),
    cu_consumed UInt32,
    args_json String DEFAULT '{}',
    result_json String DEFAULT '{}'
) ENGINE = ReplacingMergeTree(ended_ts)
PARTITION BY toYYYYMM(started_ts)
ORDER BY (cluster, program_id, signature, span_id)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_sdk_metric_1m
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (cluster, program_id, name, bucket)
AS
SELECT
    toStartOfMinute(block_time) AS bucket,
    cluster,
    program_id,
    name,
    sum(value) AS value_sum,
    count() AS samples
FROM sdk_metrics
GROUP BY bucket, cluster, program_id, name;
