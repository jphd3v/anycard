# Deterministic Integration Tests

## Goals

- Fast, deterministic checks that games are playable end-to-end (legal moves, scoring, winners).
- No browser/MCP dependency.
- Easy to run alongside lint/build.

## Testing policy (for agents)

- Default to short, scenario-based tests that target the most important rules.
- Use the smallest number of moves that proves the rule or transition.
- Full-game playthroughs are optional and should be reserved for completeness checks.
- Completeness checks should use auto mode (first legal move) with a move cap.
- If a rule accumulates engine events and then resets/deals, project piles from the accumulated events before building reset `move-cards` (see Bridge fix).

## TDD loop (high-level)

1. Write or extend the scenario(s); often the act of writing reveals inconsistencies.
2. Run the tests and observe the first failure.
3. Diagnose the rule/engine behavior that caused the failure.
4. Fix the issue and rerun until the suite is green.
5. Look for similar patterns in other games or shared engine code.
6. Update docs if the finding is worth preserving to prevent regression.

## Recommendation

Use rules-engine integration tests rather than UI E2E for the baseline.

These tests should:

- Load the game initial state with a fixed seed.
- Drive the rules engine with a deterministic list of intents.
- Apply emitted engine events to a local game state.
- Assert key checkpoints (current player, phase, scoreboards) and final winner.

## Why not full E2E for the baseline

- Current MCP-based E2E is non-deterministic and slow.
- UI automation adds noise unrelated to rules correctness.
- A backend-only loop is faster and easier to debug.

## Why not only unit tests

- Unit tests validate individual helpers but do not prove a game is playable.
- Integration tests exercise the real rules module, events, and scoring.

## Runner

The runner drives the rules engine directly (no browser) by:

- loading initial state with a fixed seed,
- applying intents via `validateMove`,
- applying emitted engine events via `applyEvent`,
- checking optional expectations.

Run all scenarios recursively:

```bash
npm run test:integration
```

Run scenarios for a specific game (e.g. durak):

```bash
npm run test:integration -- durak
```

Run a specific scenario file:

```bash
npm run test:integration -- durak/durak-basic.json
```

## Determinism and speed

- Use a fixed `seed` for each scenario.
- Avoid random AI or UI interaction.
- Prefer concise scenarios that reach a winning state quickly.

## Scope boundaries

- Keep MCP playthroughs in `test/e2e/` for optional UI checks.
- Integration tests should never require a browser or network.

## Structure

- `test/integration/scenarios/` for deterministic playthroughs, organized by game subfolders.
- `test/integration/runner/` for the scenario runner and helpers.
- One folder per game (e.g. `scenarios/bridge/`).
- Multiple scenario files per game (e.g. `bridge-basic.json`).

## Scenario format

Each scenario is a JSON file in `test/integration/scenarios/`. Files prefixed with
`_` are ignored (use `_template.json` as a starting point).

Required fields:

- `rulesId` (string)

Optional fields:

- `id` (string)
- `seed` (string)
- `gameId` (string)
- `players` (array of `{ id, name?, isAi? }`)
- `expect` (object with `winner`, `currentPlayer`, `scoreboards`, `rulesState`)

### Scripted mode (default)

Provide an explicit `intents` list.

```json
{
  "id": "bridge-basic",
  "rulesId": "bridge",
  "seed": "INTEGRATION-SEED",
  "intents": [{ "type": "action", "playerId": "P1", "action": "play" }]
}
```

### Auto mode (completeness tests)

Let the runner pick the first legal intent each step.
Use `stopWhen` to end the run once a milestone is reached (useful for long games).

```json
{
  "id": "bridge-complete",
  "rulesId": "bridge",
  "seed": "BRIDGE-INTEGRATION-1",
  "mode": "auto",
  "auto": {
    "policy": "first-legal",
    "maxMoves": 10000,
    "stopWhen": {
      "dealNumberAtLeast": 2
    }
  }
}
```

## Helper: list legal intents

Use the inspect helper to print legal intents step-by-step (and advance with the
first legal intent). This is useful for building scripted scenarios.

```bash
npm run test:integration:inspect -- bridge BRIDGE-INTEGRATION-1 20
```

## Deriving card IDs from a seed

Scenario intents use `cardId`, so you need the dealt hands for a specific seed.
A quick way is to run a small `tsx` snippet and print the piles after
`start-game`.

Example (Kasino):

```bash
npm --prefix backend exec -- tsx -e "import { loadAndValidateGameConfig } from './backend/src/game-config.ts'; import { validateMove } from './backend/src/rule-engine.ts'; import { applyEvent } from './backend/src/state.ts'; const seed='KASINO-INTEGRATION-1'; const base=loadAndValidateGameConfig('kasino', seed); const gameId='kasino-integration'; const state={...base, gameId}; const intent={type:'action', gameId, playerId:'P1', action:'start-game'}; const run=async()=>{ const result=await validateMove(state, [], intent); let next=state; for (const e of result.engineEvents) next=applyEvent(next, e); console.log('P1', next.piles['P1-hand'].cardIds); console.log('P2', next.piles['P2-hand'].cardIds); console.log('table', next.piles['table'].cardIds); }; run();"
```

Use the printed `cardIds` to author deterministic `move` intents.

## Building a complete Kasino scenario

A full-game scenario means multiple deals until someone reaches 16 points.
A practical approach:

1. Start with a fixed seed and record the initial deal.
2. Script a short, deterministic sequence that exercises key rules:
   - a capture (move to `P1-won`/`P2-won`)
   - a trail to the table
   - end-of-hand cleanup (last capturer collects remaining table cards)
3. Repeat for additional deals by issuing `start-game` when `rulesState.phase`
   returns to `dealing`.
4. Add final `expect` assertions for `winner` and `scoreboards`.

For a full game you will likely need multiple rounds of scripted moves. That is
expected: Kasino's win condition (16 points) usually requires several deals.
Keep scenarios focused and add just enough moves to reach a deterministic win.
