CREATE TABLE IF NOT EXISTS _migrations (
    version String,
    applied_at DateTime DEFAULT now()
) ENGINE = MergeTree
ORDER BY (version);

CREATE TABLE IF NOT EXISTS transactions (
    cluster LowCardinality(String),
    program_id String,
    signature String,
    slot UInt64,
    block_time DateTime,
    status LowCardinality(String),
    signer String,
    fee_lamports UInt64,
    priority_fee_lamports UInt64,
    compute_budget_consumed UInt32,
    error_code Nullable(Int32),
    error_name Nullable(String),
    commitment LowCardinality(String),
    rpc_source String,
    idl_version UInt32,
    schema_hash String,
    raw_blob_url String,
    inserted_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(slot)
PARTITION BY toYYYYMM(block_time)
ORDER BY (cluster, program_id, signature, slot);

CREATE TABLE IF NOT EXISTS instructions (
    cluster LowCardinality(String),
    program_id String,
    signature String,
    slot UInt64,
    block_time DateTime,
    ix_index UInt16,
    parent_ix_index Nullable(UInt16),
    depth UInt8,
    instruction_name String,
    args_json String,
    args_raw_hex String,
    decode_error Nullable(String),
    status LowCardinality(String),
    idl_version UInt32
) ENGINE = MergeTree
PARTITION BY toYYYYMM(block_time)
ORDER BY (cluster, program_id, signature, ix_index, depth);

CREATE TABLE IF NOT EXISTS events (
    cluster LowCardinality(String),
    program_id String,
    signature String,
    slot UInt64,
    block_time DateTime,
    event_index UInt16,
    ix_index UInt16,
    source LowCardinality(String),
    event_name String,
    payload_json String,
    raw_payload String,
    idl_version UInt32
) ENGINE = MergeTree
PARTITION BY toYYYYMM(block_time)
ORDER BY (cluster, program_id, signature, event_index);

CREATE TABLE IF NOT EXISTS account_writes (
    cluster LowCardinality(String),
    program_id String,
    account String,
    signature String,
    slot UInt64,
    block_time DateTime,
    account_type Nullable(String),
    decoded_json String,
    raw_blob_url String,
    commitment LowCardinality(String),
    idl_version UInt32
) ENGINE = MergeTree
PARTITION BY toYYYYMM(block_time)
ORDER BY (cluster, program_id, account, slot);

CREATE TABLE IF NOT EXISTS cpi_edges (
    cluster LowCardinality(String),
    program_id String,
    signature String,
    parent_ix_index UInt16,
    child_ix_index UInt16,
    callee_program LowCardinality(String),
    cu_consumed UInt32,
    status LowCardinality(String),
    depth UInt8,
    slot UInt64,
    block_time DateTime
) ENGINE = MergeTree
PARTITION BY toYYYYMM(block_time)
ORDER BY (cluster, program_id, signature, parent_ix_index, child_ix_index);

CREATE TABLE IF NOT EXISTS idl_versions (
    program_id String,
    version UInt32,
    applied_from_slot UInt64,
    applied_to_slot Nullable(UInt64),
    schema_hash String
) ENGINE = MergeTree
ORDER BY (program_id, version, applied_from_slot);

CREATE TABLE IF NOT EXISTS commitment_promotions (
    signature String,
    commitment LowCardinality(String),
    observed_at DateTime DEFAULT now()
) ENGINE = MergeTree
ORDER BY (signature, observed_at);

CREATE TABLE IF NOT EXISTS rollbacks (
    signature String,
    observed_at DateTime DEFAULT now()
) ENGINE = MergeTree
ORDER BY (signature, observed_at);
