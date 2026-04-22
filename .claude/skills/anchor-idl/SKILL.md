---
name: anchor-idl
description: Anchor IDL handling, discriminator computation, Borsh decoding rules for SolObserve. Invoke when writing or modifying crates/idl-parser, crates/schema-registry, services/decoder, or any code that decodes instructions/accounts/events. Also invoke when adding a new IDL version, handling raw (non-Anchor) programs, or extending the SDK message format.
---

# Anchor IDL & decoding

## IDL version

Target Anchor IDL format `0.30+` (the modern shape with `address`, `metadata`, `instructions`, `accounts`, `types`, `events`, `errors`).

## Discriminators

Always 8 bytes. Computed as `sha256(prefix || ":" || name)[..8]`.

| Kind        | Prefix    |
| ----------- | --------- |
| Instruction | `global`  |
| Account     | `account` |
| Event       | `event`   |

Implementation must match `anchor-syn` exactly. Unit test against committed fixtures.

## Decoding rules

- Instruction: first 8 bytes of `instruction.data` = discriminator → name + arg schema. Rest = Borsh-encoded args.
- Account: first 8 bytes of account `data` = discriminator → struct schema. Rest = Borsh-encoded fields.
- Event: emitted via `Program data: <base64>`. Decode base64; first 8 bytes = event discriminator.
- SDK event (plan 11): `Program log: __SOBS__:<tag>:<base64>` where `tag ∈ {m,e,s+,s-}`.

## Failure handling

- Unknown discriminator: insert row with `instruction_name='__unknown__'` + raw hex args. Increment `decoder_unknown_discriminator_total`. Never drop.
- Borsh decode error: insert with name set, `args_json=null`, `decode_error=<msg>`. Increment `decoder_decode_failures_total`. Never drop.
- Schema mismatch across IDL versions: resolve via schema registry by slot. Old data uses old schema.

## Raw (non-Anchor) programs

- Accept user-uploaded Borsh schema OR pluggable WASM decoder.
- Without schema, store raw hex; never crash decoder on unknown program.

## CPI tree reconstruction

Parse exact log lines, in order:

- `Program <id> invoke [<depth>]`
- `Program log: <msg>`
- `Program data: <base64>`
- `Program <id> consumed <cu> of <budget> compute units`
- `Program <id> success` / `Program <id> failed: <err>`

Build a tree per signature; attribute CU per node by `consumed` line. Depth from `[N]` bracket.

## Tests required

- Discriminator math against ≥3 real public IDLs (committed fixtures).
- 5-level CPI nesting log parser.
- Failed-then-recovered transaction CPI parsing.
- IDL upgrade: data before upload uses v1, data after uses v2.
