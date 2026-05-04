CREATE TABLE IF NOT EXISTS tx_logs (
    cluster LowCardinality(String),
    program_id String,
    signature String,
    slot UInt64,
    block_time DateTime,
    signer String,
    log_lines Array(String),
    log_lines_concat String,
    status LowCardinality(String)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(block_time)
ORDER BY (cluster, program_id, slot, signature)
SETTINGS index_granularity = 8192;

ALTER TABLE tx_logs
    ADD INDEX IF NOT EXISTS log_tokens log_lines_concat TYPE tokenbf_v1(2048, 3, 0) GRANULARITY 4;
