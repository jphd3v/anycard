# Tests

This folder groups automated tests and test assets.

## Structure

- `test/integration/` - deterministic, backend-only rules integration tests.
- `test/ui-smoke/` - Playwright UI smoke tests for engine/UI changes.

## Start here

- Integration baseline doc: `test/integration/README.md`

## Expectations

- Adding a new game requires deterministic integration scenarios under
  `test/integration/scenarios/<rulesId>/` with full rules coverage.
- Engine/architecture/UI changes require coverage in `test/ui-smoke/`.

## Run

```bash
npm run test:integration
npm run test:integration:coverage:verify
npm run test:ui-smoke
```

## Inspect legal intents

```bash
npm run test:integration:inspect -- <rulesId> [seed] [maxMoves]
```
