---
name: solana-rpc
description: Free-tier Solana RPC conventions for SolObserve — endpoint pool, rate limits, failover, WebSocket subscription patterns. Invoke when writing or modifying any code in services/ingestor, crates/solana-rpc-client, or any service that talks to Solana RPC. Also invoke when adding a new cluster, debugging RPC failures, or reviewing rate-limit handling.
---

# Solana RPC conventions

Hard rule: **never introduce a paywalled provider as required**. Paid Geyser/gRPC (Yellowstone, LaserStream) is optional accelerator only. System must run on free paths alone.

## Free endpoints assumed working

- `https://api.mainnet-beta.solana.com` (public, heavily rate-limited, ~10 req/s soft cap)
- `https://api.devnet.solana.com`
- `https://api.testnet.solana.com`
- Helius free tier (BYO key)
- QuickNode free tier (BYO key)
- Alchemy Solana free tier (BYO key)
- Shyft free tier (BYO key)
- Self-hosted RPC node

WebSocket counterparts use `wss://` with same hostnames; not all free tiers expose `blockSubscribe` — code must degrade to `logsSubscribe` + `getTransaction`.

## Required client behavior (`crates/solana-rpc-client`)

- Token-bucket per endpoint. Default 10 req/s. Configurable per endpoint.
- Exponential backoff with jitter on 429 / 503 / connection reset. Max 5 retries, cap 30s.
- Endpoint pool with health-aware pick: track `error_rate`, `latency_ema`. Pick healthiest available.
- Failover within 5s on sustained errors (3 consecutive failures or >50% error rate over 30s).
- Dedup by signature via in-memory LRU before fetching `getTransaction`. Cache TTL 10 min.
- Always set `maxSupportedTransactionVersion: 0` on `getTransaction`.
- Never call `getProgramAccounts` against free public RPC — disabled or savagely rate-limited. Use opt-in tracked accounts via `accountSubscribe` instead.

## Subscription patterns

- `logsSubscribe` filter: `{ mentions: [program_id] }` at `processed`. Primary stream.
- `blockSubscribe` if endpoint supports it (probe at startup) — preferred when available, gives full tx without separate fetch.
- Separate `logsSubscribe` at `confirmed` OR poll `getSignatureStatuses` for recently-seen sigs to drive commitment promotion.
- `accountSubscribe` per opted-in account at `processed`; promote on `confirmed`.

## Backfill

- `getSignaturesForAddress` paged until window boundary (`block_time` or `before` cursor).
- Fan out to `getTransaction` workers respecting per-endpoint token bucket.
- Resumable: store last `before` cursor in `ingestion_state`.

## Slot context for replay

- `getAccountInfo` with `min_context_slot` for historical state. If endpoint lacks history retention deep enough, return `historical_state_unavailable: true` (do not silently fall back).

## When in doubt

Ask before adding any new RPC method or any new provider. Confirm it works on free tier first.
