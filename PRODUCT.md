# SolObserve

## Register

product

## Product purpose

Observability for Solana on-chain programs. Devs upload an IDL, register a program ID, and SolObserve ingests devnet/mainnet traffic, decodes Anchor instructions and events into ClickHouse, then surfaces calls, errors, CU profile, latency, and alerts on a PromQL-style DSL.

Replaces three usual mid-flight tools for Solana devs: hand-rolled RPC scripts to tail their program, log archaeology in Helius/Solscan, ad-hoc Postgres dashboards.

## Users

Solana developers debugging programs they ship — late-night, second-monitor, switching between editor and this app. Mental load is already high from Rust/Anchor; the UI must not add cognitive cost. Information density matters; novelty does not.

Secondary: same dev one quarter later, now monitoring the program in prod for one specific instruction's failure rate.

NOT: SREs running fleets of services. NOT: marketing decks. NOT: end-user crypto wallet holders.

## Strategic principles

1. **Signal over chrome.** Every pixel earns its place. Decoration is hostile.
2. **Information density without noise.** Pack what matters tight; strip what doesn't.
3. **Address-grade typography.** Base58, hex, signatures appear constantly. Mono is a first-class type, not an accent.
4. **One color carries meaning.** Status (success/failure) and one brand accent. No decorative palettes.
5. **Hairlines, not boxes.** Borders + spacing organize content. Cards only when content needs literal isolation.
6. **Light surface, ink type.** Differentiates from every other Solana tool (Phantom/Solscan/Helius all dark). Dev's other monitor is the IDE, not this; eye strain is not the concern.

## Anti-references

- Generic dark SaaS dashboards (slate-900 + electric-blue, repeating rounded card grid). The Datadog/Vercel-analytics reflex.
- Web3 neon-on-black, magenta-cyan gradients, "glowing tech" aesthetic.
- Datadog/Grafana clones — dense tabs, blue/green status-everywhere, header chrome.
- Cream + serif AI/Notion clone aesthetic — Linear, Anthropic console, Resend.
- Modal-driven onboarding ("Welcome! Let's get you started 🎉" with confetti or progress dots that lie).
- Glassmorphism, gradient text, hero metric tiles.
