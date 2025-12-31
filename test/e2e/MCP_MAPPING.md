# MCP Mapping (Human-only Playthroughs)

This file maps playthrough text to stable DOM selectors + interactions.

Scope:

- Human-only seats (no AI seats/runtime/sponsor flows).
- Black-box UI only (no privileged backend access).

## Base URL

Default: http://localhost:5173

## Multi-context convention

We use multiple browser pages:

- Context A = Player 1 page
- Context B = Player 2 page
  (For 4-player games you'd add Context C/D.)

## Test mode enable

Enable test mode by:

- Adding `?test=1` to the URL: `http://localhost:5173/bridge?test=1`
- OR setting environment variable `VITE_TEST_MODE=true` before starting the server

Recommended for multi-page runs:

- Add `ctx=A|B|C|D` to label pages (shown in the TestHUD + page title), e.g. `/bridge?test=1&ctx=A`

## Test HUD selectors

When test mode is enabled, a HUD appears at the top showing state:

- HUD container: `[data-testid="testhud"]`
- Rules ID: `[data-testid="testhud:rulesId"]`
- Context label: `[data-testid="testhud:ctx"]` (from URL `ctx=` param)
- Game ID: `[data-testid="testhud:gameId"]`
- Seat ID: `[data-testid="testhud:seatId"]`
- Selected card (test mode click-to-move): `[data-testid="testhud:selected"]` (`none` or `<pileId>:<cardId>`)
- Connection status: `[data-testid="testhud:connected"]`
- Reset button: `[data-testid="testhud:reset"]`

## Seat selection

- Seat card container: `[data-testid="seat-card:{SEAT_ID}"]`
- Join button: `[data-testid="seat-join:{SEAT_ID}"]`
- Seat state badge: `[data-testid="seat-state:{SEAT_ID}"]` with values `open|occupied|me`

Examples:

- P1 seat join: `[data-testid="seat-join:P1"]`
- P2 seat state: `[data-testid="seat-state:P2"]`

## Start game (deal)

- Start game button: `[data-testid="start-game"]`
  (Visible only after all seats joined; text is "Start game / Deal cards".)

## Piles & cards

- Pile container: `[data-testid="pile:{PILE_ID}"]`
- Top card wrapper: `[data-testid="pile-top:{PILE_ID}"]` (one per pile, if non-empty)
- Pile count badge: `[data-testid="pile-count:{PILE_ID}"]`
- Card element: `[data-testid="card:{CARD_ID}"]` or `[data-testid="card:back:{CARD_ID}"]`

## Actions

- Action button: `[data-testid="action:{ACTION_ID}"]`

## Click-to-move interaction (test mode only)

DO NOT use drag-and-drop in test mode. Use click-to-move instead:

1. Click a card to select it (visual highlight appears)
2. Click a legal target pile to move the selected card to that pile
3. Press Escape to clear selection

### Card selection state

- Selected card: has `data-selected="true"` attribute
- Selected card summary (recommended): `[data-testid="testhud:selected"]`
- All selected cards: `[data-selected="true"]`

### Pile drop target hint (when card is selected)

- Only legal target piles have `data-droptarget="true"` attribute
- All drop targets: `[data-droptarget="true"]`

### "Top card in a pile" (when you don't know CARD_ID)

Use the top card wrapper:
`[data-testid="pile-top:{PILE_ID}"] [data-testid^="card:"]`

## Waiting / assertions

Prefer polling assertions (up to ~5s) for:

- pile counts changing
- overlays appearing/disappearing
- game ID matching between contexts (critical for multi-page coordination)
- seat states changing

## Multi-page coordination assertion

After both pages load in a multi-page scenario, add:

- `[A] Assert testhud:gameId == <value>`
- `[B] Assert testhud:gameId == same <value>`

This ensures both contexts are in the same game instance.
