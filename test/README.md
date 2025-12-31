# Tests

This folder groups automated tests and test assets.

## Structure

- `test/integration/` - deterministic, backend-only rules integration tests.
- `test/e2e/` - MCP-driven UI playthroughs (slow, non-deterministic, optional).

## Start here

- Integration baseline doc: `test/integration/README.md`
- E2E playthrough docs: `test/e2e/README.md`

## Run

```bash
npm run test:integration
```

## Inspect legal intents

```bash
npm run test:integration:inspect -- <rulesId> [seed] [maxMoves]
```
