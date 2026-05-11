# SolObserve CU Regression Action

Runs your Anchor / Solana program test suite, parses `Program <id> consumed N CU`
lines, and compares per-instruction CU against the SolObserve baseline for the
repo's default branch. Posts a markdown delta-table PR comment and fails the
check on regressions beyond `threshold-percent`.

## Usage

```yaml
- uses: solobserve/cu-regression-action@v1
  with:
    program-id: 00000000-0000-0000-0000-000000000000
    cluster: localnet
    solobserve-token: ${{ secrets.SOLOBSERVE_TOKEN }}
    threshold-percent: 5
    bypass-label: cu-regression-ok
    test-command: anchor test --skip-deploy
```

Set `solobserve-url` for self-hosted deployments.

## Build

```sh
cd tools/cu-regression-action
pnpm install
pnpm build
```

The built `dist/index.js` is what GitHub runs.
