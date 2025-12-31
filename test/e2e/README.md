# Playthrough E2E Tests (BDD)

Playthroughs are short, human-readable Markdown specs under `test/e2e/playthroughs/**`.
They are executed as **black-box UI tests** by a browser-automation agent (via MCP)
against a locally running backend + frontend.

## Quickstart (local)

1. Install deps: `npm install`
2. Start app: `npm run dev`
3. Pick a scenario under `test/e2e/playthroughs/**` and run it with an MCP-capable
   agent using:
   - Runner prompt: `test/e2e/PLAYTHROUGH_RUNNER_PROMPT.md`
   - Selector/interaction mapping: `test/e2e/MCP_MAPPING.md`

Default Base URL: `http://localhost:5173`

Tip: prefer a headless browser (e.g. Playwright headless) to avoid focus-stealing windows on macOS.

## Test mode (required)

All playthrough URLs must include `?test=1`.

In test mode the frontend provides:

- A top `TestHUD` (`data-testid="testhud:*"`) with `rulesId`, `gameId`, `seatId`,
  `selected`, `connected`, and a `Reset` button.
- **Click-to-move** card interaction (select a card, then click a legal target pile).
- Stable `data-testid` selectors for seats, actions, piles, cards, and pile counts.

## Fresh start for dedicated lobby routes

For routes like `/bridge` that use a dedicated lobby game:

- Context A should navigate to `/<rulesId>?reset=1&test=1` (forces reset)
- Other contexts should navigate to `/<rulesId>?test=1`

## Docs map

- Spec contract + style: `test/e2e/playthroughs/README.md`
- DOM selectors + interaction mapping: `test/e2e/MCP_MAPPING.md`
- Prompt template (runner): `test/e2e/PLAYTHROUGH_RUNNER_PROMPT.md`
- Prompt template (authoring): `test/e2e/PLAYTHROUGH_GENERATION_PROMPT.md`

## Cheap-LLM tips

- Keep scenarios short (≈10–25 steps) and assert only what matters.
- Prefer `testhud:*`, `pile-count:*`, and `action:*` selectors over “vision”.
- Prefer click-to-move in test mode (avoid drag-and-drop).
