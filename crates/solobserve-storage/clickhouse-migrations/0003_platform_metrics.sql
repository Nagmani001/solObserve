CREATE TABLE IF NOT EXISTS platform_metrics (
    cluster LowCardinality(String) DEFAULT '',
    source LowCardinality(String),
    metric_name String,
    value Float64,
    labels_json String DEFAULT '{}',
    ts DateTime DEFAULT now()
) ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (metric_name, source, ts);
