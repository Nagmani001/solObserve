CREATE TABLE IF NOT EXISTS platform_metrics (
    metric String,
    source LowCardinality(String),
    value Float64,
    labels String DEFAULT '{}',
    observed_at DateTime DEFAULT now()
) ENGINE = MergeTree
PARTITION BY toYYYYMM(observed_at)
ORDER BY (metric, source, observed_at);
