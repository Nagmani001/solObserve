# solobserve-sdk — CU Cost Reference

Measured cost in Solana compute units (CU) per macro call, with the SDK built
in `release` and `dev` feature modes.

Methodology: a one-instruction program built against `solana-test-validator`
with the macro under test invoked inside an `#[observed]` handler. Each row is
the median of 1000 invocations; raw runs are in `benches/cu_overhead.rs` (host
encode benchmark) and the optional BPF rig under `benches/onchain/`.

| Macro                       | dev (default) | release (no-op) | Notes                              |
| --------------------------- | ------------: | --------------: | ---------------------------------- |
| `metric!("n", v)`           |      ~ 950 CU |            0 CU | Borsh encode + base64 (no labels). |
| `metric!("n", v, [labels])` |    ~ 1 280 CU |            0 CU | Two label pairs. Scales linearly.  |
| `event!("name", &payload)`  |    ~ 1 100 CU |            0 CU | 32-byte Borsh payload.             |
| `span_start!`               |      ~ 800 CU |            0 CU | Empty args.                        |
| `span_end!`                 |      ~ 850 CU |            0 CU | Empty result.                      |
| Combined `#[observed]` wrap |    ~ 1 700 CU |            0 CU | One span_start + one span_end.     |

## Caps

The acceptance criterion for plan 11 is **< 50 CU per call in release mode**.
Release mode compiles every macro to a no-op (`fn(...) {}`), so the measured
cost is **0 CU**. Dev mode is intentionally chatty: payloads are emitted via
`msg!()` and pay the syscall + log-buffer cost. Teams running on mainnet
should depend on the crate with `default-features = false, features =
["release"]`.

## Tuning

If dev-mode CU matters for your local validator throughput, the cheapest
optimisations are:

1. Skip labels you don't need (each label = ~ 80 CU extra).
2. Reuse buffers via `event!` with pre-encoded payloads.
3. Sample at the call site: `if slot % 10 == 0 { metric!(...) }`.

## Bench harness

```sh
cargo run --release --example cu_overhead -p solobserve-sdk
```

Host numbers (encode + format only, no on-chain syscall):

| Macro      | ns/op (release host) |
| ---------- | -------------------: |
| metric     |                  380 |
| event      |                  410 |
| span_start |                  300 |
| span_end   |                  320 |

The host bench is a regression guard; the CU table above is the source of
truth and is refreshed on each SDK release.
