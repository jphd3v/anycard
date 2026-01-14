# Adding a new card game

This document is **only** for adding a new card game (e.g. Canasta) to the
universal card engine.

It is written for coding agents and humans. The goal is:

- implement a new game **as a plugin**,
- using **only** the existing engine features,
- with **no changes** to the backend core, frontend, or AI framework,
- **aim for completeness**: implement all rules faithfully to the real-world classical version, without watering them down for digital convenience,
- **maintain real-world analogy**: ensure interactions and state transitions reflect the mental model of playing with physical cards.

If anything below is unclear or the requested game does not seem compatible,
**stop and ask the user** instead of modifying the engine.

---

## 0. Scope and hard constraints

When the task is "add a new game", you MUST obey these constraints:

- ✅ You MAY:
  - add a new rule module under `backend/src/rules/impl/`
  - add a new game folder under `rules/<game>/`
  - register the game in `backend/src/rules/registry.ts`
  - add a `meta.json` and optional `*.rules.md` under `rules/<game>/`

- ❌ You MUST NOT:
  - modify backend core engine files (socket handling, state, shuffler, etc.)
  - modify frontend components, layout system, or card renderer
  - add new engine event types or change shared schemas
  - change AI infrastructure or LLM configuration
  - touch anything under `test/` unless explicitly instructed
  - add new dependencies or env vars

If implementing the requested game seems to require any of the above, **stop
and ask the user**. Do not "improve" the engine in this mode.

---

## 1. Pre-check: is this game compatible?

Before you create or edit any file, perform this compatibility check.

When in doubt, also cross-check with the "Supported card game profile
(constraints)" section in `ARCHITECTURE.md`.

1. **Card system check**
   - The game must be playable with:
     - a standard French 52-card deck (4 suits, ranks 2–10, J, Q, K, A),
     - or a **subset** of that deck (e.g., 36-card deck with ranks 6–A for Durak),
     - or multiple such decks (e.g. two decks for Canasta),
     - optionally with up to **two jokers** (red and black), or only one of
       them, or none.
   - The current engine/renderer does **not** support fully custom card
     systems (Uno, Tarot with special majors, CCG-specific symbols, etc.).

   **CRITICAL NOTE**: If your game uses a non-standard deck size (e.g., 36 cards for Durak instead of 52), you MUST:
   - Create a custom `cards` object in `initial-state.json` with exactly the right number of cards
   - Update the deck validation in your rule module to expect the correct deck size
   - Add clear comments explaining why the deck size is different
   - Document this in `rules/<rulesId>/<rulesId>.rules.md` to prevent copy-paste errors

   **Common Pitfall**: Copying a 52-card deck from another game (like Bridge) and forgetting to reduce it to the correct size for games that use subsets (like Durak's 36-card deck). This will cause runtime errors when the rule module validates deck size.

   If the game needs a completely new card system or custom graphics beyond
   the standard suits/ranks + up to two jokers, ask the user; do not try to
   extend the engine in "new game" mode.

2. **UI model check**

   The game must be expressible using only:
   - piles (hands, table piles, discard piles, decks),
   - scoreboards (rectangular tables),
   - an optional grid of action buttons.

   If the game needs:
   - special scoreboards that are not representable as normal tables
     (for example: highly customized historical scoring sheets),
   - custom widgets beyond piles/scoreboards/buttons (free text input,
     sliders, complex diagrams),

   then it is **not** a simple "new game" task. Ask the user whether they
   want an approximation using existing features or actual engine/UI work.

3. **Turn/phase model check**

   The game must be representable as:
   - event-sourced turns,
   - players acting via **card moves** or **button actions**,
   - phases encoded in `rulesState` (e.g. `phase: "deal" | "bidding" | "play" | "scoring"`).

   If the game depends on true real-time play or fully simultaneous moves
   with no meaningful order, ask the user; you should not try to force such
   a design into the engine.

4. **Betting / gambling check**

   The engine does **not** support real betting, chips, or monetary stakes
   as first-class concepts.
   - If the game is essentially a betting game (e.g. casino-style poker or
     blackjack with stakes and payouts), this is **out of scope** for a
     simple "add a new game" task.
   - We can support **betless** variants:
     - e.g. poker with no betting where you just score hands,
     - blackjack-like games where players aim for 21 and points are tracked
       on a scoreboard.

   If the requested design requires real stakes or betting tokens as part
   of the rules, stop and ask the user.

5. **Table geometry check**

   The engine uses a rectangular grid of zones with piles and widgets.
   - You **can** approximate interesting layouts (e.g. a rough "circle"
     made from several piles arranged around the table) using pile layout
     styles.
   - You **cannot** rely on exact geometric notions like a true circle or
     continuous track as first-class engine concepts.

   Games whose rules critically depend on an exact geometric formation
   (for example: certain traditional games like the Finnish _Sika_, where
   cards are laid out in a true circle on the table) should be treated as
   "engine/UI change" rather than a simple new plugin.

If you are **not sure** the game fits these constraints, do not proceed.
Summarize the concerns and ask the user for confirmation or a simplified
variant. Do **not** loosen these constraints on your own.

---

## 2. Files you must add / touch

For a new game with id `<rulesId>` (e.g. `"canasta"`), you work in these places:

### 2.1 New files per game

Create this folder:

- `rules/<rulesId>/`

Inside it, you MUST create:

1. `rules/<rulesId>/meta.json`
2. `rules/<rulesId>/<rulesId>.initial-state.json`
3. `rules/<rulesId>/<rulesId>.layout.json`

Optionally you MAY also create:

- `rules/<rulesId>/<rulesId>.layout-wide.json`
- `rules/<rulesId>/<rulesId>.layout-portrait.json`
- `rules/<rulesId>/<rulesId>.rules.md` (user-facing rules text only)

In the backend, you MUST add:

4. `backend/src/rules/impl/<rulesId>.ts` (rule module + plugin export)

### 2.2 Existing files to touch

You MAY touch exactly one shared file:

- `backend/src/rules/registry.ts` – register your new plugin.

Do not change any other shared file unless explicitly instructed.

---

## 3. Initial state JSON

**File:** `rules/<rulesId>/<rulesId>.initial-state.json`

This file defines:

- players,
- piles (hands, deck(s), table piles, etc.),
- initial `rulesState`,
- initial `actions` (should be empty: `{"rows": 0, "cols": 0, "cells": []}`. Do **not** include `"start-game"` here; the UI provides that overlay automatically. Use actions only for operations that cannot be expressed as a direct card move, or when a hidden/random card choice should be made server-side),
- initial `scoreboards` (**REQUIRED**: provide at least a placeholder or zeroed scoreboard so the "Scores" button is visible in the UI from the start).

### 3.1 Minimal required structure

At a high level:

```jsonc
{
  "rulesId": "<rulesId>",
  "players": [
    { "id": "P1", "name": "Player 1" },
    { "id": "P2", "name": "Player 2" },
  ],
  "piles": {
    "P1-hand": { "ownerId": "P1", "visibility": "owner", "cardIds": [] },
    "P2-hand": { "ownerId": "P2", "visibility": "owner", "cardIds": [] },
    "deck": {
      "ownerId": null,
      "visibility": "hidden",
      "shuffle": true,
      "cardIds": [1, 2, 3 /* ... */],
    },
  },
  "currentPlayer": null,
  "winner": null,
  "rulesState": {
    /* game-specific state */
  },
  "actions": {
    "rows": 0,
    "cols": 0,
    "cells": [],
  },
  "scoreboards": [
    {
      "id": "main-score",
      "title": "Score",
      "rows": 3,
      "cols": 2,
      "cells": [
        { "row": 0, "col": 0, "text": "Player", "role": "header" },
        { "row": 0, "col": 1, "text": "Score", "role": "header" },
        { "row": 1, "col": 0, "text": "P1", "role": "body" },
        { "row": 1, "col": 1, "text": "0", "role": "body" },
        { "row": 2, "col": 0, "text": "P2", "role": "body" },
        { "row": 2, "col": 1, "text": "0", "role": "body" },
      ],
    },
  ],
}
```

**Important:**

- Do **not** include any `layout` field on piles in the initial state.
  Table geometry and pile layout are defined only in the layout JSON files (`<rulesId>.layout*.json`).
- Do **not** seed action buttons here. Set `rows: 0`, `cols: 0`, `cells: []` and emit
  `set-actions` from your rule module whenever the grid should change (e.g. right after
  `start-game` / dealing if the game uses an action grid).
- Required fields that often get missed:
  - Every pile entry must include `id`, `ownerId`, `visibility`, and `cardIds` (can be empty).
  - `players` must be an array of objects with at least an `id` (string) and optional `name` — not just bare strings.
  - Top-level `currentPlayer` and `winner` must exist (`null` if unknown); the engine/zod schema requires them.
  - When in doubt, copy a working initial-state (e.g. `rules/bridge/bridge.initial-state.json`) and adjust.

Use existing games (Bridge, Gin Rummy, Scopa, Kasino) as concrete examples.

### 3.2 Player Naming Conventions

Use consistent naming for players throughout a game. The naming should be used uniformly in:

- Initial state (`players[].id` and `players[].name`)
- Scoreboards
- Recap/history messages
- UI labels

**Convention Guidelines:**

1. **Traditional/game-specific naming (preferred when applicable):**
   - Partnership card games traditionally use compass directions: `N`, `S`, `E`, `W`
   - Use this for Bridge, Canasta, and similar 4-player partnership games
   - Full names: "North", "South", "East", "West"
   - Short aliases: "N", "S", "E", "W"
   - Partnerships: "NS" / "EW" or "North-South" / "East-West"

2. **4-player games without compass tradition:**
   - If compass naming doesn't fit, use `N`, `S`, `E`, `W` anyway (it's a reasonable default)
   - Alternatively, use positional naming: `P1`, `P2`, `P3`, `P4`

3. **2-3 player games:**
   - Use positional naming: `P1`, `P2`, `P3`
   - Full names: "Player 1", "Player 2", "Player 3"
   - Short aliases: "P1", "P2", "P3"

4. **Short vs. full names:**
   - Use short aliases ("P1", "N") in recap messages and constrained UI elements
   - For simple games with spacious scoreboards (e.g., Katko), full names ("Player 1") are fine

**Examples:**

```jsonc
// Bridge/Canasta (4-player partnership games)
"players": [
  { "id": "N", "name": "North" },
  { "id": "E", "name": "East" },
  { "id": "S", "name": "South" },
  { "id": "W", "name": "West" }
]

// Gin Rummy (2-player game)
"players": [
  { "id": "P1", "name": "Player 1" },
  { "id": "P2", "name": "Player 2" }
]
```

**Consistency Rule:**
Once you choose a naming convention for a game, use it **everywhere**:

- ✅ Scoreboard headers: "N", "S" or "P1", "P2"
- ✅ Recap messages: "N won trick 3" or "P1 went out"
- ✅ Team labels: "NS" or "Team A (P1 & P3)"
- ❌ Don't mix: "Player 1 (North)" in one place and "P1" in another

### 3.3 Decks, hands, and shuffling

Rules for decks:

- Every card id must appear in **exactly one** pile.
- The union of all `cardIds` in all piles must match the `cards` object.
- Piles with `"shuffle": true` are shuffled by the engine using the game seed
  when the game is created.
- The rules are responsible for dealing cards from deck to hands using
  `move-cards` engine events.

**CRITICAL: Deck Size Validation**

Many games have specific deck size requirements:

- **Standard games** (Bridge): 52 cards (ranks 2-A, all suits)
- **Russian games** (Durak): 36 cards (ranks 6-A, all suits)
- **Italian/Spanish games**: 40 cards (ranks 1-7, J, Q, K, all suits)
- **Custom games**: May use subsets or multiples

**Best Practices:**

1. **Research your game's standard deck size** before creating initial state
2. **Count your cards**: Verify `cardIds` array length matches expected deck size
3. **Add validation**: Include deck size check in your rule module's `dealFromDeck()`
4. **Document**: Add comments in initial-state.json explaining the deck size
5. **Test early**: Validate deck size before implementing complex game logic

**Common Mistake Example:**

```json
// ❌ WRONG: Copying 52-card deck for Durak (needs 36 cards)
"cardIds": [1, 2, 3, ..., 52]  // 52 cards - will fail validation

// ✅ CORRECT: Durak uses 36-card deck
"cardIds": [1, 2, 3, ..., 36]  // 36 cards - passes validation
```

Typical pattern:

- A `"deck"` pile with `visibility: "hidden"` and `shuffle: true`.
- One `"*-hand"` pile per seat with `visibility: "owner"` and empty `cardIds`.

### 3.4 Hidden piles and drawing cards

Clients receive `CardView.id` values (opaque per viewer), while engine card IDs
stay server-side. Ranks/suits are stripped when they are not visible.

**Pile Visibility Modes:**

- **`public`**: Full stack visible, all cards **face-up**. Use for discard piles or shared table cards.
- **`owner`**: Full stack visible. Cards are **face-up for the owner** and **face-down for everyone else**. Use for player hands.
- **`hidden`**: Full stack visible, but **all cards are face-down for everyone**. Use for draw decks/stock piles where players should see the stack size but not the contents.

For drawing from a face-down deck/stock pile, prefer an `action` intent so the
server chooses the top card and the player does not have to select a hidden
`cardId` manually. Use direct `move` intents when the player can see and choose
a specific card.

- **✅ PREFER direct card moves when a card is visible and selectable**: If a
  player can naturally express an action by dragging a visible card from one
  pile to another, implement it as a `move` intent rather than an `action`
  button.

- **✅ USE actions for hidden/random choices**: If the player should not pick a
  specific card (deal, draw from hidden deck, reveal-random, shuffle, pass,
  declare, end hand), use an `action` intent and let the rules pick the card.

**Examples of when to use direct card moves:**

- Drawing the top card from a visible stock pile to hand
- Playing a card from hand to a tableau, meld pile, or discard pile
- Moving cards between table piles (e.g., building sequences in solitaire games)
- Taking cards from a discard pile to hand or meld area
- Any operation where the player can see and select specific cards

**Tip: Face-down Discard Piles**
If your game involves a discard or waste pile where players are not supposed to see the history of played cards (or to reduce visual clutter), set `visibility: "hidden"` in `initial-state.json`. Combined with `"layout": "complete"` in `layout.json`, this creates a clean, face-down stack.

**Examples of when action buttons are appropriate:**

- Passing a turn ("pass")
- Declaring special game states ("declare", "go-out")
- Ending a hand or phase ("end-hand")
- Operations where the player does not choose a specific card (deal, shuffle, draw from hidden deck, reveal-random, etc.)

**Rationale:**

- Direct card moves provide a more intuitive, visual interface
- They align with the engine's drag-and-drop philosophy
- Players can see exactly which cards they're moving
- Reduces cognitive load compared to action buttons
- Follows the pattern established by well-designed games like Canasta

Do **not** expose hidden piles in the layout unless the real game shows them.

### 3.5 Validation hints and shared piles

**Important:** If your game needs to access hidden piles (like the deck) during rule validation, you must add those pile IDs to the `sharedPileIds` array in the `validationHints` of your game plugin.

```typescript
export const myGamePlugin: GamePlugin = {
  id: "mygame",
  // ... other properties ...
  validationHints: {
    // Include all piles that rules need to see, even if they're hidden
    sharedPileIds: ["trick", "briscola", "deck"],
  } satisfies ValidationHints,
};
```

**Common cases requiring shared piles:**

- **Deck piles**: When dealing initial cards or drawing cards during gameplay
- **Trick/battle piles**: When determining trick winners or battle outcomes
- **Shared table piles**: When rules need to validate moves based on table state

**Why this matters:**

The validation state builder (`buildValidationState`) only includes full card details for:

- Piles marked as `visibility: "public"`
- Piles owned by the acting player
- Piles explicitly listed in `sharedPileIds`

If a hidden pile (like `visibility: "hidden"` deck) is not in `sharedPileIds`, the rules module will see the pile's `size` but not the individual `cards`, causing errors like "No deck pile or deck.cards missing".

**Best practice:**

Always review your game's logic and add any piles that the rules module needs to access to the `sharedPileIds` array. This is especially important for:

- Initial dealing phases
- Card drawing logic
- Trick/battle resolution
- Any rule that needs to examine cards in non-public piles

### 3.6 Turn management: critical rules

**CRITICAL:** The rule module is **solely responsible** for managing turn order. There is no automatic turn switching in the engine. If you don't explicitly emit `set-current-player` events, the turn will never change!

**Common turn management patterns:**

#### Trick-taking games (Briscola, Bridge, etc.)

```typescript
// After first card played to trick:
if (trickCardsAfterMove.length === 1) {
  // MUST change turn so opponent can play
  const nextPlayer = getOtherPlayer(currentPlayer, players);
  engineEvents.push({
    type: "set-current-player",
    player: nextPlayer,
  });
}

// After trick is complete (2 cards):
if (trickCardsAfterMove.length === 2) {
  const winner = determineTrickWinner(trickCardsAfterMove, trumpSuit);
  // Winner plays first in next trick
  engineEvents.push({
    type: "set-current-player",
    player: winner,
  });
}
```

#### Simple alternating turns (Bridge, etc.)

```typescript
// After any valid move:
const nextPlayer = getOtherPlayer(currentPlayer, players);
engineEvents.push({
  type: "set-current-player",
  player: nextPlayer,
});
```

#### Games with phases or special turn rules

```typescript
// Check game phase and apply appropriate turn logic
if (rulesState.phase === "bidding") {
  // Bidding might go clockwise
  const nextPlayer = getNextPlayerClockwise(currentPlayer, players);
  engineEvents.push({ type: "set-current-player", player: nextPlayer });
} else if (rulesState.phase === "play") {
  // Play might alternate
  const nextPlayer = getOtherPlayer(currentPlayer, players);
  engineEvents.push({ type: "set-current-player", player: nextPlayer });
}
```

**Turn management checklist:**

- [ ] **Every valid move must result in a turn change** (unless the game explicitly allows multiple consecutive moves by the same player)
- [ ] **Never assume "no current player change needed"** - this is almost always wrong
- [ ] **The rule module MUST emit `set-current-player`** - the engine will not do it automatically
- [ ] **Test turn transitions manually** - play through at least 3-5 turns to verify the sequence
- [ ] **Consider edge cases**: What happens when a trick ends? When the deck is empty? When the game ends?

**Common mistakes to avoid:**

❌ **Mistake:** "No current player change needed" comment without emitting `set-current-player`
✅ **Fix:** Always emit `set-current-player` after every valid move

❌ **Mistake:** Only changing turns when a trick/battle is complete
✅ **Fix:** Change turns after EVERY card play that should trigger a turn change

❌ **Mistake:** Forgetting to set the initial player after dealing
✅ **Fix:** Always set `currentPlayer` in the initial deal logic

**Debugging tip:**

If turns aren't changing, add this debug check:

```typescript
// At the end of validate(), before returning:
const hasTurnChange = engineEvents.some((e) => e.type === "set-current-player");
if (!hasTurnChange && intent.type === "move") {
  console.warn("⚠️  No turn change emitted for move intent!");
}
```

This will catch missing turn changes during development.

---

## 4. Layout JSON

**File:** `rules/<rulesId>/<rulesId>.layout.json`
(optional: `layout-wide.json`, `layout-portrait.json`)

The layout describes where piles and UI widgets appear in the table view.

- This is the **only** place where pile layout (horizontal/vertical/complete/spread) is defined.
  The core `GameState` / `initial-state.json` are purely about game mechanics, not visuals.
- Default for hands: use a fanned layout (`"horizontal"` or `"vertical"`) so players see their
  whole hand. Use `"complete"` stacking only for intentionally hidden piles (e.g., facedown
  stocks) or games that truly demand a single top card. If in doubt, fan hands.
- Layout JSON **must** validate against `GameLayoutSchema` (`shared/schemas.ts`).
  - Always include `"rulesId": "<rulesId>"` at the top-level.
  - Mark player hand piles with `"isHand": true` inside the `pileStyles` object. This is used for targeting animations (e.g. `lastAction`) and ensuring they originate or terminate at the correct player's hand.
  - Ensure the file is valid JSON (no trailing commas, no comments).

### 4.1 Grid basics

- Layout zones are arranged on a grid with:
  - `rows` – count of rows
  - `cols` – count of columns

- Every `cell` uses **zero-based** `row` and `col` indices:
  - valid rows: `0..rows-1`
  - valid cols: `0..cols-1`

- `rowspan` and `colspan` are counts of how many rows/cols to span.

Do **not** offset indices by +1; the frontend does that internally.

### 4.2 Zones and widgets

Each zone is either:

- a list of `piles` to render, or
- a `widget` zone for:
  - `"actions"` – the actions grid,
  - `"scoreboards"` – the scoreboards grid.

**CRITICAL RULES**:

- **NEVER** place multiple zones in the same cell. Overlapping widgets or piles in the same grid coordinate will cause rendering conflicts and make the game unplayable.
- **NEVER** combine a `widget` and `piles` in the same cell.
- **MANDATORY `piles` PROPERTY**: Every zone MUST include a `piles` property, even if it is an empty array (e.g. `"piles": []` for widget zones). The frontend assumes this array exists to map players to zones; omitting it will cause a runtime crash.
- **GRID BOUNDS**: The `rows` and `cols` defined at the top of the layout file MUST be strictly greater than the maximum `row` and `col` indices used in any zone. (e.g. if you use `"row": 2`, you must have at least `"rows": 3`).

Actions and scoreboards are always available in the top header UI. Usually,
in-table widgets should be avoided in the layout zones. Exception: if a game has
only a single action or a very small action set and the layout has room, it is
preferable to include a small `widget: "actions"` zone on the table for clarity
(avoids needing to toggle the actions panel). For action-heavy games, keep
actions in the header by default. Scoreboards can still be placed on the table
when space allows and they are central to gameplay.

**Note:** If you include a `widget: "actions"` zone but your game does not use
any in-game action buttons (i.e. it only uses card moves and the "Start Game"
overlay), the UI will render an empty "No actions" placeholder.

**Zone Naming Convention**: Use absolute player IDs in zone names instead of relative terms:

- ✅ **Preferred**: `"P1-hand"`, `"P2-hand"`, `"P1-area"`, `"P2-melds"`
- ❌ **Avoid**: `"my-hand"`, `"opp-hand"`, `"player-area"`, `"enemy-melds"`

This ensures consistency and prevents confusion when viewing the game from different player perspectives. The zone IDs should clearly identify which player they belong to using the standard player IDs (`P1`, `P2`, `P3`, `P4`).

Example:

```jsonc
{
  "zones": [
    {
      "id": "P2-hand",
      "cell": { "row": 0, "col": 0, "rowspan": 1, "colspan": 2 },
      "piles": ["P2-hand"],
    },
    {
      "id": "table",
      "cell": { "row": 1, "col": 0, "rowspan": 1, "colspan": 2 },
      "piles": ["P1-hand", "table-pile"],
    },
    {
      "id": "P1-hand",
      "cell": { "row": 2, "col": 0, "rowspan": 1, "colspan": 2 },
      "piles": ["P1-hand"],
    },
    {
      "id": "scoreboards",
      "cell": { "row": 1, "col": 2 },
      "piles": [], // REQUIRED even for widgets
      "widget": "scoreboards",
    },
  ],
}
```

### 4.3 Decks in the layout

In this engine, the total card count for the `"deck"` pile is always visible to all players in the top-right header UI. For this reason, the deck does not usually need to be rendered on the table, saving valuable screen space.

**Rules of thumb:**

- **Hide the deck (Default)**: If the deck is just a source for automated dealing or simple "Draw" actions, do **not** include it in any layout zone.
- **Show the deck**: Only include `"deck"` in a zone's `piles` if the game requires direct interaction (e.g., dragging cards from it) or if seeing its physical location is essential.
  - **CRITICAL**: If you show the deck and want it to be face-down, set `visibility: "hidden"` in `initial-state.json`. If you want it face-up, use `visibility: "public"`.
  - **Labeling**: Always use the label `"Deck"` for the pile with ID `deck` in layout, scoreboards, and rules to match the header UI. Avoid alternative terms like "Stock" or "Draw Pile".

- **The "Trump Under Deck" Pattern (Durak/Briscola)**:
  If a game requires a face-up card to be placed under the deck:
  1. Create a separate pile (e.g., `id: "trump-card"`) with `visibility: "public"`.
  2. In your layout, place `trump-card` in the same zone as the `deck` (or where the deck would be).
  3. The `trump-card` will be visible to everyone, while the remaining deck size remains visible in the header.

### 4.4 Wide vs portrait layouts

Optional:

- `rules/<rulesId>/<rulesId>.layout-wide.json`
- `rules/<rulesId>/<rulesId>.layout-portrait.json`

Selection:

- Portrait: `layout-portrait` → `layout`.
- Landscape: `layout-wide` → `layout`.

If you don't need special handling, you can provide only `layout.json`.

### 4.5 Optional view-only sorting for piles

You can give players a default hand/table ordering without changing engine
state by adding a `sort` block under `pileStyles.<pileId>`. This is
client-side only; backend pile order stays canonical. If the real rules
require a specific order, enforce it in the rule module via `move-cards`.

Schema (all fields optional):

- `default`: sorter id to apply on load.
- `options` (array, **required** if `sort` exists): each sorter has:
  - `id`, `label`
  - `type`: `"bySuitRank"`, `"byRank"`, `"bySuit"`, or `"explicit"`
  - `rankOrder` / `suitOrder`: arrays of rank/suit strings matching the card
    definitions you already use (e.g. `"A"`, `"K"`, `"10"`, `"spades"`, `"H"`)
  - `order` (for `explicit`): list of `{ "rank": "...", "suit": "..." }`
    pairs giving the exact display sequence (repeat entries for duplicates)
  - `includeFaceDown` (default `false`): if `false`, piles with any face-down
    cards are left unsorted
  - `applyToLayouts`: optional list of pile layouts this sorter may apply to

- `allowViewerToggle`: defaults to `true`; when true and multiple options
  exist, the UI shows a small selector for that pile.

**Important:** Whenever you add custom sorting options to a pile, you MUST:

- Always include a "Native order" option (with `id: "native"` and `label: "Native order"`) in the `options` array. This allows players to return to the original deal/play order.
- Use **ascending order** for both ranks and suits in your sort definitions (e.g., 2..A or the lowest rank to the highest).

Example:

```jsonc
{
  "pileStyles": {
    "P1-hand": {
      "layout": "horizontal",
      "sort": {
        "default": "bridge",
        "options": [
          {
            "id": "bridge",
            "label": "S/H/D/C, A high",
            "type": "bySuitRank",
            "suitOrder": ["spades", "hearts", "diamonds", "clubs"],
            "rankOrder": [
              "A",
              "K",
              "Q",
              "J",
              "10",
              "9",
              "8",
              "7",
              "6",
              "5",
              "4",
              "3",
              "2",
            ],
          },
          {
            "id": "table-special",
            "label": "Exact show order",
            "type": "explicit",
            "order": [
              { "rank": "JOKER", "suit": "black" },
              { "rank": "A", "suit": "spades" },
              { "rank": "K", "suit": "spades" },
            ],
          },
        ],
      },
    },
  },
}
```

- Default ordering guideline: for trick/point games, use **ascending rank order left-to-right** (e.g., 2..A or the smallest rank in your deck up to A) unless the game explicitly requires something else.
- Layout safety guideline: ensure each zone's `cell` (row/col/rowspan/colspan) does not overlap with others. A quick visual check after the first deal helps catch pile/widget collisions early.

### 4.6 Pile layout styles guidelines

Choosing the right layout style significantly impacts game usability. Follow these guidelines:

#### **Complete** (`"layout": "complete"`)

Use for piles where only the top card matters or should be visible:

- **Stock/deck piles** (face-down draws)
- **Discard piles** (when cards underneath are not supposed to be seen or only the top card matters)
- **Waste piles** in solitaire-style games
- **Hidden information** piles that shouldn't reveal card order
- **Foundation piles** in games like Pyramid where only the top card is accessible

#### **Horizontal** (`"layout": "horizontal"`)

Use for piles where order matters and cards should be read left-to-right:

- **Player hands** (default for most games)
- **Trick piles** (best for showing play order while keeping cards recognizable)
- **Discard piles** (shows chronological order: first card on left)
- **Melds and sets** (especially in rummy games)
- **Capture piles** where the order of capture is important
- **Bidding rows** or scoring areas

#### **Vertical** (`"layout": "vertical"`)

Use for piles that benefit from top-to-bottom reading:

- **Trick piles** in card games where tricks are visually stacked
- **Column-based layouts** (like Spider Solitaire)
- **Foundation columns** in Klondike Solitaire
- **Player areas** where vertical organization feels more natural

#### **Spread** (`"layout": "spread"`)

Use for piles where all cards are equally important and should be visible simultaneously:

- **Tableau piles** in solitaire games (like Golf or TriPeaks)
- **Market/table cards** where all options are equally accessible (like Kasino)
- **Shared card areas** where players can see all available choices
- **Building areas** in games where multiple cards work together

**Decision tips:**

- If players need to **see all cards** at once → `spread`
- If players need to see the **order of play** → `horizontal` (left-to-right) or `vertical` (top-to-bottom)
- If only the **top card matters** → `complete`
- When in doubt, use **horizontal** for hands and discard piles (most intuitive)

### 4.7 General Layout Patterns

Whenever it makes sense for the game type, prefer a layout where the **main interaction area** (e.g., the trick pile, battle area, or shared table) is in the **center** of the grid, with player hands arranged around it.

**Examples:**

- **2 Players (Head-to-Head):**
  - Row 0: Opponent Hand (Top)
  - Row 1: Shared Table / Trick / Discard (Center)
  - Row 2: Your Hand (Bottom)

- **4 Players (Bridge/Whist style):**
  - Center: Trick / Table
  - Top: Partner/Opponent 1
  - Bottom: You
  - Left/Right: Opponents

This creates a natural "sitting around the table" feel and keeps the focus on the active cards.

---

## 5. Rule module (`backend/src/rules/impl/<rulesId>.ts`)

This file contains **all** game-specific logic.

### 5.1 Required exports

You MUST export:

- a `GameRuleModule` implementation, and
- a `GamePlugin` that references it.

Rough skeleton:

```ts
import type {
  GameRuleModule,
  GamePlugin,
  ValidationState,
  ClientIntent,
  EngineEvent,
} from "../../shared/schemas"; // adjust actual import paths

function deriveActions(rulesState: any, currentPlayerId: string | null) {
  // return an ActionsGrid or null
}

function deriveScoreboards(rulesState: any) {
  // return Scoreboard[]
}

export const <rulesId>RuleModule: GameRuleModule = {
  validate(state: ValidationState, intent: ClientIntent) {
    const engineEvents: EngineEvent[] = [];

    // 1. Reject obvious illegal moves (game over, wrong player, etc.)
    if (state.winner) {
      return {
        valid: false,
        reason: "Game is already finished",
        engineEvents: [],
      };
    }

    // 2. Handle intents (move and action)
    // - validate using PRE-MOVE state
    // - push engineEvents for legal moves

    // 3. Compute next rulesState, actions, scoreboards
    const nextRulesState = /* compute from state + intent */;
    const actions = deriveActions(nextRulesState, state.currentPlayer);
    const scoreboards = deriveScoreboards(nextRulesState);

    engineEvents.push({ type: "set-rules-state", rulesState: nextRulesState });
    engineEvents.push({ type: "set-actions", actions });
    engineEvents.push({ type: "set-scoreboards", scoreboards });

    // optionally: engineEvents.push({ type: "set-current-player", playerId: ... });
    // optionally: engineEvents.push({ type: "set-winner", winner: ... });

    return { valid: true, engineEvents };
  },
};

export const <rulesId>Plugin: GamePlugin = {
  id: "<rulesId>",
  displayName: "Nice Game Name",
  description: "Short description for the lobby.",
  ruleModule: <rulesId>RuleModule,
};
```

Use existing implementations (`bridge.ts`, etc.) as direct references.

### 5.2 Pre-move model (short version)

Rules run in a **pre-move** model:

- `ValidationState` describes the game **before** the current move is applied.
- For a move intent:
  - the card is still in `state.piles[fromPileId]`,
  - it is **not yet** in `state.piles[toPileId]`.

You must:

- validate the move using this pre-move state, and
- emit **all** necessary engine events, including the actual `move-cards`.

### 5.3 Engine-level validations (what you don't need to check)

The engine performs several pre-validations before your rule module's `validate()` function is called (see `backend/src/intent-handler.ts`). These checks are **already done**, so you don't need to duplicate them in your rule module:

**Engine guarantees for `move` intents:**

- ✅ Game is not already finished (winner is not set)
- ✅ `cardId` XOR `cardIds` is present (exactly one, never both, never neither)
- ✅ `cardIds` array is non-empty when used
- ✅ The source pile (`fromPileId`) exists
- ✅ Every `cardId` in the intent exists in the source pile (`fromPile.cardIds.includes(cardId)`)
- ✅ The move is not a no-op (`fromPileId !== toPileId`)

**What this means for your code:**

```typescript
// ✅ SAFE - engine guarantees cardId is defined for move intents
const cardId = intent.cardId!;

// ✅ SAFE - engine guarantees card exists in source pile
const card = fromPile.cards!.find((c) => c.id === cardId)!;

// ❌ NOT NECESSARY - engine already checked this
if (intent.cardId === undefined) {
  return { valid: false, reason: "Move requires cardId.", engineEvents: [] };
}

// ❌ NOT NECESSARY - engine already checked this
if (!fromPile.cardIds.includes(cardId)) {
  return { valid: false, reason: "Card not in source pile.", engineEvents: [] };
}
```

**Philosophy: Better safe than sorry**

While these engine-level checks make certain defensive validations redundant, **you are still allowed to add them if it makes your code clearer or more defensive**. The engine's guarantees are firm, but defensive programming is a valid choice. The key insight is that you **don't have to** duplicate these specific checks—the engine has your back.

**What you MUST still validate:**

Your rule module remains responsible for **game-specific logic**:

- Turn validation (is it this player's turn?)
- Phase validation (is this action allowed in the current game phase?)
- Move legality (does this card play follow the game rules?)
- Pile ownership (can this player move from this pile?)
- Card combinations (is this a valid meld/sequence/capture?)

### 5.5 Engine events you should use

You should only use the existing event types:

- `move-cards`
- `set-current-player`
- `set-winner`
- `set-rules-state`
- `set-scoreboards`
- `set-actions`
- `announce`
- (optional) `fatal-error` for catastrophic situations (rare, usually engine side)

Do **not** invent new event types.

#### Announcements (`announce`)

The engine supports lightweight, transient UI announcements for high-signal game moments.
Use this sparingly to improve clarity, not as a play-by-play log.

**Good uses (examples):**

- A trick winner (“Trick won by …”)
- A sweep / scopa (“Sweep by …!”)
- A key phase transition (“Bidding ended: …”)
- A hand/round milestone (“Hand 2 Result: …”)
- A rare declaration (“Marriage declared in …”)

**Avoid:**

- Announcing every normal card move
- Repeating information already obvious from the move itself

**Event shape:**

```ts
engineEvents.push({
  type: "announce",
  text: "Sweep by P1!",
  // optional
  anchor: { type: "pile", pileId: "table" },
});
```

**Anchors:**

- Omit `anchor` to show it centered (implicit).
- Use `{ type: "screen" }` for explicit center.
- Use `{ type: "pile", pileId }` to position near a pile (falls back to center if the pile is not present in the current layout).

#### Canonical pile order

When you emit `move-cards`:

- `event.cardIds` is treated as a set of cards to move.
- The engine takes the cards in the **source pile's existing order** and appends
  them to the destination pile.

So you do **not** need to encode order in `event.cardIds`; the source pile is
the single source of truth.

### 5.6 `rulesState`, actions, and scoreboards

Use `rulesState` as your long-term memory:

- phase (`"deal" | "play" | "scoring" | ...`)
- scores
- trick/battle/bidding state
- flags like `hasDealt`, `round`, etc.

Whenever `rulesState` or `currentPlayer` changes, re-derive:

- `actions` – the grid of buttons for the current player,
- `scoreboards` – the tables shown in the scoreboards widget.

**Crucial**: The `deriveActions` function should only return buttons for _gameplay_ decisions (Pass, Bid, Take, etc.). **Do not** add `"start-game"` to this grid; it is handled automatically by the engine's lifecycle overlay when `hasDealt` is false.

Then emit:

```ts
engineEvents.push({ type: "set-rules-state", rulesState: nextRulesState });
engineEvents.push({ type: "set-actions", actions });
engineEvents.push({ type: "set-scoreboards", scoreboards });
```

If you don't emit them, the UI won't update.

**Privacy rule:**

- `rulesState`, `actions`, and `scoreboards` are **broadcast to all clients** via `GameView`.
- Face-down card hardening only hides **card faces**, not **derived facts**.
- Do **not** put private-hand-derived values into `scoreboards` (or `rulesState`) unless they’re meant to be public.
- If you need “each player sees their own private row” (e.g. deadwood points in Gin Rummy), implement `deriveScoreboardsForView(...)` in your rule module. It allows you to return different scoreboards for `"__spectator__"`, `"__god__"`, and specific player IDs.

**Scoreboard layout preference:**

- For simple score displays, prefer a two-column table with player names in the first column and scores in the second column. Use richer tables only when the game needs extra breakdowns.

### 5.8 Start-game / dealing pattern (when needed)

For games that require dealing from a shuffled deck:

- Add a boolean flag `hasDealt: false` in `rulesState`.
- The UI uses a `"start-game"` action intent; handle it in your rule module.

**Important:** Do **NOT** add the `"start-game"` button to `initial-state.json`. The frontend automatically detects `hasDealt: false` and shows a "Start Game" overlay. Adding it manually creates duplicates and confusion.

In your rule module:

1. When `hasDealt === false` and `intent.type === "action"` and
   `intent.actionId === "start-game"`:
   - emit `move-cards` events to deal from `deck` to hand piles,
   - set `hasDealt: true` and transition phase (`"deal"` → `"play"` or `"bidding"`),
   - set `currentPlayer` appropriately,
   - emit `set-actions` and `set-scoreboards` **immediately after dealing**.

2. When `hasDealt === false` and any other move arrives:
   - reject with `valid: false` and a clear `reason`.

The AI system never sends `"start-game"`; a human must start the game.

### 5.9 Rule module isolation

Keep each game's rules **self-contained**:

- Do not import helpers from other game files.
- Do not create shared helper modules for "trick logic", "meld detection", etc.
- It is fine to duplicate small utility functions per game.

### 5.10 Scoreboard initialization best practices

**Important:** For games with scoring systems that include penalties (like rummy-style games), **do not** calculate negative scores immediately after dealing cards. This creates confusing starting positions where players appear to be "losing" before the game begins.

**Correct approach:**

- Start all players with 0 points when the game begins
- Only calculate full scores when a hand/round ends (when someone wins)
- For ongoing score tracking across multiple hands, maintain cumulative scores in `rulesState`

**Example for rummy-style games:**

```ts
// ❌ WRONG: Calculate penalties immediately after dealing
const initialProjected = projectPilesAfterEvents(state, engineEvents);
const { scoreboard } = calculateScores(initialProjected, nextRulesState);

// ✅ CORRECT: Start with 0 scores, update only when hand ends
const cells: ScoreboardCell[] = [];
cells.push({ row: 0, col: 0, text: "Player", role: "header" });
cells.push({ row: 0, col: 1, text: "Score", role: "header" });

players.forEach((p, i) => {
  cells.push({ row: i + 1, col: 0, text: p, role: "body" });
  cells.push({ row: i + 1, col: 1, text: "0", role: "body" }); // Start at 0!
});
```

**When to calculate scores:**

- After someone wins a hand/round
- When a game phase ends with scoring
- When explicitly requested by game rules (e.g., scoring at intermediate milestones)

This ensures players start with a clean slate and only see meaningful score changes when actual game events occur.

### 5.11 Direct card moves vs action buttons: best practices

**✅ PREFER direct card moves (drag-and-drop) over action buttons whenever possible.**

This is a core design principle of the engine and leads to better user experiences.

**When to use direct card moves (`move` intents):**

- Drawing visible cards from stock to hand
- Playing cards from hand to tableau, meld piles, or discard
- Moving cards between table piles (building sequences, capturing, etc.)
- Taking cards from discard piles
- Any operation where players can see and select specific cards

**When action buttons (`action` intents) are appropriate:**

- Game initialization ("start-game")
- Turn/phase management ("pass", "end-turn")
- Special declarations ("declare", "go-out", "claim")
- Operations involving hidden cards where players shouldn't choose `cardId`s
- Complex operations that can't be expressed as simple card movements

**Why this matters:**

1. **Better UX**: Drag-and-drop is more intuitive than clicking buttons
2. **Visual clarity**: Players see exactly which cards they're moving
3. **Consistency**: Follows the pattern of well-designed games like Canasta
4. **Engine philosophy**: Aligns with the drag-and-drop interaction model

**Implementation tip:**

When adding melding functionality (like in Pinnacola), implement direct card moves first:

```typescript
// Good: Support direct card moves to meld piles
if (
  intent.type === "move" &&
  intent.fromPileId === `${playerId}-hand` &&
  intent.toPileId === `${playerId}-melds`
) {
  // Validate and execute the meld
  // ... validation logic ...
  engineEvents.push({
    type: "move-cards",
    fromPileId: intent.fromPileId,
    toPileId: intent.toPileId,
    cardIds: [intent.cardId],
  });
  return { valid: true, engineEvents };
}
```

Only add action-based alternatives if direct moves are truly insufficient for the game mechanics.

### 5.12 Atomic Moves vs. Transactional Turns (Deferred Validation)

Many games involve complex turns where a player makes multiple moves to achieve a valid state (e.g., building a meld, rearranging a tableau, or exchanging cards). Since the engine processes one move at a time, you must not validate the "final legal state" too eagerly.

**The Principle:**
Allow players to be in a "temporarily invalid" state _during_ their turn, as long as they resolve it before _ending_ their turn.

**Human Players vs AI Players:**

This pattern primarily serves **human players** using drag-and-drop:

- Humans move cards one at a time (drag one card, then another)
- Validation is deferred until they commit (e.g., discard)
- They can undo intermediate moves if they change their mind

For **AI players**, use **multi-card intents** instead (see section 7.3):

- AI receives complete meld options as single candidates (e.g., "meld 3 Kings")
- No intermediate states needed - AI makes one decision
- Reduces AI decision space from many micro-moves to few meaningful choices

These are complementary patterns:

- **Deferred validation**: Enables incremental human interaction
- **Multi-card intents**: Enables efficient AI decision-making

Both achieve the same game outcome (e.g., a valid 3-card meld) through different interaction models.

**Strategy:**

1.  **Immediate Checks (Atomic Validity):**
    When a user moves a card, check only fundamental constraints (e.g., rank/suit matching).
    - _Ask:_ "Is it _ever_ legal to put this card here?"
    - _If yes:_ Allow it, even if the resulting pile size or sum is currently insufficient.

2.  **Deferred Checks (Turn Completion):**
    When the user tries to **commit** or **end turn** (e.g., by discarding or clicking "Pass"), validate the entire board state.
    - _Ask:_ "Is the board in a valid state to pass control to the next player?"
    - _If no:_ Reject the end-turn action with a helpful message.

**Guardrails (Minimal, Obvious Rules):**
It is OK to block clearly illegal starts even mid-turn when the rules demand it. Example: in Canasta, do not allow a partnership to begin melding until the initial meld minimum (points + meld composition) is satisfied. These guardrails prevent accidental misplays and keep AI from making invalid exploratory moves, without over-automating the game.

**High-Level Pattern:**

```text
// 1. On Intermediate Card Move
IF move is structurally valid (e.g., correct suit/rank match):
   ALLOW move
   (Even if the pile is currently too small or incomplete)

// 2. On End Turn Action (e.g., Discard / Pass)
IF total board state is valid (e.g., all piles meet min size):
   ALLOW end turn
ELSE:
   REJECT end turn
   ERROR "You have incomplete sets on the table."
```

This ensures you don't block players from performing the necessary intermediate steps (like placing the first card of a set) to reach a valid state.

**Reversibility & Recovery (Critical)**

If you use relaxed validation, you **must** allow players to fix their mistakes.

- **Problem:** A player places a card on a meld, realizing later they cannot complete the set (e.g., they only have 2 cards).
- **Deadlock:** If the engine prevents them from moving the card back to their hand, they are stuck. They can't complete the meld, and they can't undo the move.
- **Solution:** You MUST implement and expose "undo" moves.
  - Track cards played during the current turn (e.g., `cardsPlayedToMeldsThisTurn: []`).
  - Allow these specific cards to be moved back to the hand.
  - Explicitly include these recovery moves in `listLegalIntentsForPlayer`.

**AI Guidance & Intent Enumeration (Crucial)**

When using deferred validation, your `listLegalIntentsForPlayer` implementation MUST be aware of the "end turn" criteria.

- **The Rule**: Never return an intent in `listLegalIntentsForPlayer` that `validate()` would reject.
- **The Application**: If the board is in a "temporarily invalid" state, you MUST filter out "end-turn" intents (like Discard or Pass) from the legal moves list.
- **The Result**: This forces the AI to continue making intermediate moves (building melds or taking cards back) until it reaches a valid state where discarding is finally allowed.

### 5.13 Descriptive Error Messages

**CRITICAL:** Never return a generic `"Illegal move"` or `"Invalid action"` reason. The `reason` field in `ValidationResult` is the only way the user knows why their interaction failed.

**Best Practices:**

- **Be Specific**: Instead of `"Wrong player"`, use `"It is currently Player 2's turn."`
- **Explain the "Why"**: Instead of `"Invalid card"`, use `"You must follow suit: ♥️."` or `"That card does not fit in this sequence."`
- **Handle Declarer/Dummy confusion**: In games where one player might control multiple hands, explicitly name the hand that _should_ be acting (e.g., `"It is the Dummy's turn. Please play from the Dummy hand."`).
- **Action Requirements**: If an action is disabled, explain what is missing (e.g., `"You need at least 3 cards to form a meld."`).

Good error messages reduce user frustration and make the game feel polished and professional.

### 5.14 Standard Card Notation

To ensure a consistent and high-quality user experience, all games MUST use standardized notation when displaying card ranks and suits in user-facing messages (e.g., validation error reasons, scoreboard labels, action labels).

Use the utility provided in `backend/src/util/card-notation.ts` (imported as `../../util/card-notation.js` in rule implementations):

- **`getSuitSymbol(suit: string): string`**: Returns the emoji symbol (e.g., `"spades"` -> `♠️`).
- **`formatCard(rank: string, suit: string): string`**: Formats a card name (e.g., `formatCard("7", "spades")` -> `"7♠️"`).

**Guidelines:**

- **Never hardcode suit names** in user-facing strings. Use `getSuitSymbol(suit)` instead of `"spades"`.
- **Use `formatCard`** when referring to a specific card in a message.
- **Scoreboards**: Use symbols in headers or cell text.
- **Action Labels**: Use symbols in buttons (e.g., `"Declare ♣️"` instead of `"Declare Clubs"`).

### 5.12 Handling Multiple Rounds (Deals)

Many card games (Bridge, Kasino, Scopa, etc.) are played over multiple hands or "deals". The engine provides a standard pattern to handle these transitions robustly and ensure fair randomization.

#### The "Next Round" Overlay Pattern

To provide a natural break between rounds where players can review scores, use the following pattern in `rulesState`:

1.  **State Flags**:
    - `hasDealt: boolean`: Tracks if the current hand's cards are on the table.
    - `dealNumber: number`: A counter that increments with every full deck deal.
2.  **Round End**:
    - When a hand ends, move all cards back to the `deck` pile (explicitly iterating through all non-deck piles; avoid using the unsupported `"any"` pile ID). You can use `gatherAllCards(...)` from `backend/src/rules/util/dealing.ts`; if you already queued events, pass `previousEvents` so the projection is accurate.
    - Increment `dealNumber`.
    - Set `hasDealt: false`.
    - This state automatically triggers the "Continue to next round" overlay in the frontend.
3.  **Round Start**:
    - The player clicks "Start next round" (sending a `"start-game"` action).
    - The rule module's `validate` function catches `"start-game"` when `hasDealt` is false.
    - **Shuffle**: Use the game `seed` (from `ValidationState`) and the current `dealNumber` to perform a deterministic shuffle of the deck.
    - **Deal**: Emit `move-cards` events to distribute the _shuffled_ cards.
    - Set `hasDealt: true`.

#### Deterministic Shuffling Utility

Because the engine's default shuffling only happens once at game creation, rule modules are responsible for reshuffling between rounds. To ensure consistency across clients and AI, this shuffle **must be deterministic** based on the game seed.

Prefer using the helper utilities in `backend/src/rules/util/dealing.ts` (for example, `shuffleAllCards(...)`) instead of copy-pasting PRNG/shuffle code. Use `distributeRoundRobin(...)` only if the game actually deals in an alternating one-by-one fashion; block dealing or deck-order dealing should stay custom.

Standard utility implementation to copy-paste:

```ts
// Mulberry32 - Simple, fast, seedable PRNG
function createRandom(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates shuffle
function fisherYates<T>(array: T[], random: () => number): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function stringToSeed(str: string): number {
  let hash = 0,
    i,
    chr;
  if (str.length === 0) return hash;
  for (i = 0; i < str.length; i++) {
    chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return Math.abs(hash);
}

// In validate('start-game'):
const baseSeed = stringToSeed(state.seed || "GAME_ID");
const random = createRandom(baseSeed + rulesState.dealNumber);
const shuffledCards = fisherYates(allCardIds, random);
```

By combining `seed` and `dealNumber`, every round is uniquely randomized but perfectly reproducible across all players and the AI.

### 5.13 Standard Dealing Pattern (Option A)

The engine supports two patterns for dealing cards from the deck. For consistency and animation efficiency, **you MUST use Pattern A**.

- **Pattern A: Direct Deal (Standard)**: Calculate the shuffled order in memory and emit `move-cards` events from the `deck` directly to the target hand or table piles.
- **Pattern B: High-Fidelity Reorder (Alternative)**: Emit a `move-cards` event from `deck` to `deck` to reorder it first, then deal. (Avoid this for now).

By using Pattern A, you ensure the cleanest event log and the most efficient frontend animations.
Pattern A only describes the event shape; the actual dealing order is
game-specific. Do not force round-robin if the real rules deal in blocks or
preserve the remaining deck order.

### 5.14 Best Practices for State Management

To prevent common bugs and ensure compatibility with deterministic integration tests, follow these guidelines:

1.  **Prefer `null` over `undefined`**: Always use `null` for explicitly missing or empty values in `rulesState` and scoreboard data. `undefined` keys are often omitted during JSON serialization, which causes mismatches in integration tests.
    - ✅ **Correct**: `result: string | null`
    - ❌ **Avoid**: `result?: string` or `result: string | undefined`

2.  **The State Overwriting Pitfall**: When performing multiple updates to the rules state within a single `validate()` call, always spread the _latest_ copy of the state (`nextRulesState`), not the original input (`rulesState`).
    - ❌ **Wrong**:
      ```typescript
      let nextRS = { ...rulesState, points: 10 };
      // ... later ...
      nextRS = { ...rulesState, phase: "ended" }; // BUG: 'points: 10' is LOST here!
      ```
    - ✅ **Correct**:
      ```typescript
      let nextRS = { ...rulesState, points: 10 };
      // ... later ...
      nextRS = { ...nextRS, phase: "ended" }; // 'points: 10' is preserved
      ```

3.  **Consistent `result` Field**: Every game's `rulesState` MUST include a `result: string | null` field. This provides a standardized way to communicate the reason for game-over or specific outcome details.

4.  **Incremental updates**: Keep your `validate` function clean by building a local `nextRulesState` variable and applying all changes to it before finally emitting the `set-rules-state` event.

---

### 5.10 Local State Projection and Visibility

The engine uses `ValidationState` to enforce anti-cheating rules. This means that for any pile not visible to the acting player (e.g., the opponent's hand), the `.cards` array is **missing (undefined)**.

However, rules often need to "project" what the state will look like after a move to update scoreboards or check win conditions.

#### The "Golden Pattern" for `projectPilesAfterEvents`

Never initialize hidden piles as empty arrays (`[]`). Instead, use `undefined` or a specific structure that tracks `size` independently of `cards`.

```typescript
function projectPilesAfterEvents(
  state: ValidationState,
  events: EngineEvent[]
) {
  const projected: Record<string, { size: number; cards?: SimpleCard[] }> = {};

  // 1. Initialize from ValidationState
  for (const [id, pile] of Object.entries(state.piles)) {
    projected[id] = {
      size: pile.size,
      cards: pile.cards, // May be undefined for hidden piles!
    };
  }

  // 2. Apply events to the projection
  for (const event of events) {
    if (event.type !== "move-cards") continue;
    const from = projected[event.fromPileId];
    const to = projected[event.toPileId];

    // Update sizes (always known)
    if (from) from.size = Math.max(0, from.size - event.cardIds.length);
    if (to) to.size += event.cardIds.length;

    // Update cards ONLY if they are visible in the projection
    if (from?.cards) {
      const ids = new Set(event.cardIds);
      from.cards = from.cards.filter((c) => !ids.has(c.id));
    }
    // Note: If 'to' is hidden but 'from' was visible,
    // the cards move into 'undefined' space. This is correct.
  }
  return projected;
}
```

#### Handling "Blind" Actions (Derivation)

Sometimes a rule must interact with cards it cannot see (e.g., "take a random card from opponent's hand" or "calculate final score when hand ends").

**The Strategy: Derivation by Elimination**
Since every game uses a fixed set of cards (e.g., standard 52-card deck), you can derive what is in a hidden pile by seeing what is **not** everywhere else.

```typescript
// Deriving the opponent's hand in a 2-player game
const knownCardIds = new Set<number>();
for (const pile of Object.values(state.piles)) {
  if (pile.cards) {
    for (const c of pile.cards) knownCardIds.add(c.id);
  }
}

const opponentCardIds: number[] = [];
for (const cardIdStr of Object.keys(state.allCards)) {
  const id = Number(cardIdStr);
  if (!knownCardIds.has(id)) {
    opponentCardIds.push(id);
  }
}
```

#### Key Rules for Visibility:

1.  **Never assume `.cards` is defined.** Always use optional chaining (`?.`) or check for existence.
2.  **Use `.size` for counts.** The `size` property is always accurate, even for hidden piles.
3.  **Hiding is not Emptiness.** A pile with `size: 5` and `cards: undefined` is not empty; it's just hidden.
4.  **Publicity on End.** Many games (like Gin Rummy) reveal all hands at the end. Your local projection should handle the transition from hidden to public if the phase changes to `ended`.

### 5.15 AI Context: Recap and Facts

The AI system has two sources of information for making decisions:

1. **Candidates** from `listLegalIntentsForPlayer` → what moves are legal (required)
2. **Context** from `aiSupport.buildContext` → game history and state facts (strongly encouraged)

Without context, the AI only sees the current board state and legal moves. It has no memory of what happened earlier in the game. For good AI play, you SHOULD implement both.

#### Recap: Game History for AI

**Why recap matters:** Card games involve tracking information over time—what cards were played, who won which tricks, what was discarded. Without this history, the AI plays "blind" and makes poor decisions.

**The pattern:**

1. Store `recap: string[]` in your `rulesState` (persists across turns)
2. Update it during `validate()` as meaningful events occur
3. Expose it via `aiSupport.buildContext()`

**Best practices:**

- Keep entries concise (1 line each)
- Track meaningful events, not every atomic action
- Collapse detailed entries to summaries at natural boundaries (e.g., end of hand)
- Bound the array size (e.g., last 50-80 entries) to prevent unbounded growth

**Examples by game type:**

- **Trick-taking games (Bridge, Katko):**
  - Per trick: `"Trick 3: P1 K♠️, P2 7♠️ → P1 wins"`
  - At hand end, collapse to: `"Hand 2: P1 won last trick. Scores: P1=2, P2=1"`

- **Rummy-style games (Canasta, Gin Rummy):**
  - Per turn: `"P2: drew from stock, melded 3 cards, discarded K♠️"`
  - At hand end, collapse to: `"Hand 1: P3 went out. Scores: A=150, B=-50"`

#### Facts: Structured State for AI

Facts are optional structured data about the current game state. Use them for information that's important for decision-making but not obvious from the board:

- `phase: "bidding"` or `"playing"`
- `trumpSuit: "spades"`
- `mustFollowSuit: true`
- `leadSuit: "hearts"`

Facts should be **objective state**, not strategy hints.

#### Implementation

```typescript
// 1. Add recap to your rulesState interface:
interface MyGameRulesState {
  // ... other fields ...
  recap: string[]; // Game history for AI
}

// 2. Update recap during validate():
nextRulesState.recap = [
  ...rulesState.recap,
  `${playerId}: played ${formatCard(card)}`,
];

// 3. Implement buildContext in your plugin:
aiSupport: {
  buildContext: (view: AiView): AiContext => {
    const rulesState = getRulesState(
      (view.public as { rulesState?: unknown }).rulesState
    );

    return {
      recap: rulesState.recap.length > 0 ? rulesState.recap : undefined,
      facts: {
        phase: rulesState.phase,
        // Add game-specific facts here
      },
    };
  },
},
```

**Reference:** See `bridge.ts` for a complete implementation with recap collapsing at hand boundaries.

**Fairness Principle:** Facts must only expose information that human players can
see on screen. For example, if the UI renders a discard pile showing only the
top card, include `topDiscardCard: "K♠"` in facts rather than exposing all pile
contents. This ensures AI has no unfair information advantage over humans.

**Note:** While `aiSupport` is technically optional, games without it will have significantly weaker AI play. All games in this repository should implement `buildContext` with at least a basic recap.

**Pile Projection Utility:**

Use `projectPilesAfterEvents` from `../util/piles.js` when you need to preview state changes:

- Essential for pre-validating scoring or board state
- Correctly handles card movement across multiple events

```typescript
import { projectPilesAfterEvents } from "../util/piles.js";

// Preview state after events
const projected = projectPilesAfterEvents(state, engineEvents);
const handScore = calculateScore(projected);
```

**Key Principles:**

- Provide **objective game state**, not strategy advice
- Only include information visible to the AI seat
- Keep facts structured and concise

---

### 6. Verification and Quality Assurance

## 7. Registry and metadata

### 6.1 Register the plugin

**File:** `backend/src/rules/registry.ts`

- Import your `<rulesId>Plugin`.
- Add it to the `GAME_PLUGINS` map with key `<rulesId>`.

Example:

```ts
import { canastaPlugin } from "./impl/canasta";

export const GAME_PLUGINS: Record<string, GamePlugin> = {
  bridge: bridgePlugin,
  canasta: canastaPlugin,
};
```

### 6.2 Metadata

**File:** `rules/<rulesId>/meta.json`

**CRITICAL:** All game metadata MUST be defined in the meta.json file. **Never**
hard-code metadata in the TypeScript rule files. The rule module should load
core metadata using `loadGameMeta(rulesId)` (gameName/description/etc), while
UI-only fields like `supportsActions` are read directly by the frontend.

**Schema (recommend all fields; core fields required):**

```json
{
  "rulesId": "<rulesId>",
  "gameName": "Canasta",
  "description": "Classic melding card game.",
  "minPlayers": 2,
  "maxPlayers": 4,
  "category": "Rummy",
  "supportsActions": true
}
```

**Field definitions:**

- `rulesId` (string, required): Must match the game folder name and plugin ID
- `gameName` (string, required): Display name for the game (e.g., "Canasta")
- `description` (string, recommended): Short description for the lobby/game selection
- `minPlayers` (number, recommended): Minimum number of players supported
- `maxPlayers` (number, recommended): Maximum number of players supported
- `category` (string, recommended): Game category (e.g., "Rummy", "Trick-Taking", "Battle", "Solitaire")
- `supportsActions` (boolean, recommended): Set to `true` if the game uses action buttons (e.g., "Pass", "Declare", "Knock"). This helps the UI expose the Actions button and tutorial highlights even before actions are emitted.

**Correct usage in TypeScript:**

```typescript
import { loadGameMeta } from "../meta.js";

const META = loadGameMeta("pinnacola");

export const pinnacolaPlugin: GamePlugin = {
  id: "pinnacola",
  gameName: META.gameName,
  ruleModule: pinnacolaRules,
  description: META.description, // ✅ Load from meta.json, NOT hard-coded
  validationHints: {
    // ...
  },
};
```

**Common mistakes to avoid:**

❌ **Mistake:** Hard-coding metadata in TypeScript

```typescript
export const pinnacolaPlugin: GamePlugin = {
  id: "pinnacola",
  gameName: META.gameName,
  ruleModule: pinnacolaRules,
  description: "Classic Pinnacola (Rummy variant)", // ❌ Hard-coded!
  // ...
};
```

✅ **Fix:** Always load from meta.json

```typescript
export const pinnacolaPlugin: GamePlugin = {
  id: "pinnacola",
  gameName: META.gameName,
  ruleModule: pinnacolaRules,
  description: META.description, // ✅ Loaded from meta.json
  // ...
};
```

**Why this matters:**

1. **Consistency**: All game metadata is in one place
2. **Maintainability**: Easier to update game info without touching TypeScript code
3. **Localization**: Future-proof for multi-language support
4. **Validation**: Easier to validate metadata structure
5. **Documentation**: Clear separation of concerns between data and logic

**Validation tip:**

Add this to your build process to catch hard-coded metadata:

```bash
# Check for hard-coded descriptions in rule files
grep -r "description:\s*[\"'][\"']" backend/src/rules/impl/*.ts
```

If this returns any results (except template files), you have hard-coded metadata that should be moved to meta.json.

### 6.3 User-Facing Rules Doc (Required)

**File:** `rules/<rulesId>/<rulesId>.rules.md`

You MUST create this file. It is displayed in the UI via the "Help" button during gameplay and in the Lobby. It must be human-readable, use standard Markdown, and accurately reflect your TypeScript implementation.

**Style Guide:**

- **Descriptive Tone:** Use a descriptive, third-person tone (e.g., "The player captures table cards..." or "Players form partnerships...") rather than an imperative tone (e.g., "Capture table cards" or "Form partnerships"). The rules should describe what happens in the game rather than commanding the reader.
- **Exceptions for Strategy:** The **Game Strategy** section at the end is an exception and may use a more direct or imperative tone to provide advice.
- **Human-Readable:** Do not use internal IDs (e.g., use "Player 1" instead of "P1", "Deck" instead of `deck` pile ID).
- **Visuals:** Use high-visibility colorful suit symbols: ♠️ (Spades), ♥️ (Hearts), ♦️ (Diamonds), ♣️ (Clubs). These ensure clarity and consistent sizing across different operating systems. This applies to both the rules markdown files and any UI-facing text generated in TypeScript (e.g., scoreboard headers or labels).
- **Truth:** The rules must match the `validate()` logic exactly. If your implementation differs from standard rules (e.g., "Single deal only" vs "Rubber scoring"), explicitly state it in "Implementation Notes".
- **Transparency on Automation:** Explicitly mention any subtle automations or heuristics that affect gameplay. For example, if the engine automatically picks the "best" combination for a capture or sort in a fishing style game, briefly explain the logic used (e.g., "The game prioritizes capturing the maximum number of cards"). Avoid deep technical details; focus on how it impacts the player's choices.
- **Inspiration:** You can use existing markdown files (e.g., `rules/katko/katko.rules.md` or `rules/gin-rummy/gin-rummy.rules.md`) as inspiration for formatting and tone, but your content must be totally independent and based on your specific game implementation.

**Standard Structure Template:**

```markdown
## Overview

1-2 sentences summarizing the game type (Trick-taking, Rummy, etc.) and the objective. Use a descriptive third-person tone.

## Setup

- **Deck**: e.g. "Standard 52-card deck".
- **Ranking**: **REQUIRED**. Briefly state the card ranking and Ace handling.
  - e.g., "Aces high (A K Q J 10 9 8 7 6 5 4 3 2)."
  - e.g., "Aces low (2 3 4 5 6 7 8 9 10 J Q K A)."
  - e.g., "Aces can be both high and low."
- **Players**: e.g. "2 players (P1 vs P2)".
- **Deal**: How many cards? Is there a discard pile?

## Turn Structure

Explain the core loop. Use sub-headers if needed (e.g., `### Phase 1: Draw`, `### Phase 2: Play`).

- Explicitly state constraints: "You must draw before discarding."

## [Core Mechanics]

Add sections specific to the game type, for example:

- **Melding**: What sets/runs are valid?
- **Capturing**: How do you capture cards?
- **Bidding**: What are the legal bids?

## Scoring and Winning

- How are points calculated?
- What triggers the end of the game (score threshold, empty deck, empty hands)?

## Game Strategy

Provide 1-3 bullet points on basic strategy for new players.
```

**Reference:** See `rules/pinnacola/pinnacola.rules.md` for the gold standard example.

---

## 7. AI support (required for games in this repo)

All games shipped in this repository are expected to be AI-playable.  
That means your rule module MUST implement:

```ts
listLegalIntentsForPlayer(state: ValidationState, playerId: string): ClientIntent[]
```

There are two layers of AI support:

- **`listLegalIntentsForPlayer` (required):** returns **atomic legal moves**.
  This drives both the UI and the AI baseline.
- **`AiSupport` (optional, recommended for complex games):** provides
  AI-friendly candidates (including **multi-step macros**) and recap/facts
  for better play. `applyCandidateId` may return a single intent or an array
  of intents to execute in order.

Requirements:

- **MANDATORY: Initial Start-Game**: Must return `{ type: "action", action: "start-game" }` (and ONLY that) when `hasDealt` is false. Automated test runners and AI seats rely on this intent to progress from the initial state.
- Must return **only** moves that `validate(state, intent)` would accept. **This is critical**: if you use deferred validation, you must not list "end turn" moves until the board is valid.
- Must encode any turn/phase restrictions (must draw, must discard, bidding, etc.).
- Must be deterministic for the same `(state, playerId)`.
- **Optimization Tip**: Avoid returning a "combinatorial explosion" of moves. For example, in a game with 10 meld piles, don't suggest moving every card to every pile. Filter by basic rules (e.g., "Only suggest moving a card to a meld pile if the rank matches or it's a wild card"). Excessive candidates significantly slow down AI thinking time.
- The acting player's own hidden piles (e.g., their hand) are fully visible in
  `state.piles` for this function, so you can safely enumerate card-by-card moves.
  Do **not** assume visibility into opponents' hidden piles.
- Return engine card IDs inside move intents (`intent.cardId`) as usual; the engine
  translates `cardId` to/from client-visible `CardView.id` automatically.

### 7.1 AI Candidate Safety (Action IDs)

**CRITICAL**: When defining `action` intents (buttons), the `action` ID acts as the unique handle for the LLM to select that move.

- **Rule**: Action IDs MUST be **simple, ASCII-only strings** (e.g., `pass`, `bid-1c`, `take-all`).
- **Forbidden**: Do NOT use Unicode symbols, emojis, or spaces in the `action` ID itself.
  - ❌ `action: "bid-1♥️"` (LLMs often hallucinate or mis-encode symbols in JSON)
  - ✅ `action: "bid-1h"` (Safe, reliable)
- **Display**: Use the `label` field in `ActionCell` for the user-facing text with symbols.
  - `id: "bid-1h"`, `label: "1♥️"`

If you violate this, the AI may fail to select the move, return "unknown candidate", or hallucinate invalid JSON.

If you are experimenting locally and skip this method, the engine will fall back to generic heuristics (buttons + simple card moves), but this is **not acceptable** for contributions to this repo. Missing `listLegalIntentsForPlayer` for a game is treated as a bug, not an intentional AI-disabled mode.

You **do not** need to worry about the AI policy format when adding a new
game. The engine will assign opaque ids (`c0`, `c1`, ...) and pass those to
the model. If you implement `AiSupport`, the engine still remaps your
candidate ids to `cX` before calling the LLM.

### 7.2 Fireproof Legal Intents (Candidate + Filter Pattern)

To prevent bugs where the AI sees illegal moves (or misses legal ones), you MUST use the **Candidate + Filter** pattern. This ensures that the logic for "what is legal" is never duplicated between `listLegalIntentsForPlayer` and `validate`.

**The Pattern:**

1.  **Generate Candidates**: Create a list of all "logically possible" intents (e.g., every card in hand to every possible target pile, every available action button).
2.  **Filter by Validation**: Iterate through the candidates and call `this.validate(state, candidate)`.
3.  **Return Valid Only**: Only return the intents where `validation.valid === true`.

**Example:**

```typescript
listLegalIntentsForPlayer(state: ValidationState, playerId: string): ClientIntent[] {
  const intents: ClientIntent[] = [];
  const candidates: ClientIntent[] = [];

  // 1. Generate logical candidates
  candidates.push({ type: "action", action: "pass", ... });

  const hand = state.piles[`${playerId}-hand`]?.cards ?? [];
  for (const card of hand) {
    candidates.push({ type: "move", toPileId: "discard", cardId: card.id, ... });
    // ... other logical targets ...
  }

  // 2. Filter using the single source of truth (validate)
  for (const c of candidates) {
    if (this.validate(state, c).valid) {
      intents.push(c);
    }
  }

  return intents;
}
```

**Benefits:**

- **Zero Logic Duplication**: Rules like "must follow suit" or "must have 3 cards to meld" are only written once in `validate`.
- **Absolute Consistency**: If a move is legal for a human player (UI), it is guaranteed to be visible to the AI, and vice versa.
- **Maintenance**: When rules change, you only update `validate`. `listLegalIntentsForPlayer` remains "fireproof."

### 7.3 Multi-Card Move Intents

For rummy-style games (Canasta, Gin Rummy, etc.) where players meld multiple cards as a single action, use **multi-card move intents**:

```typescript
// Multi-card meld (e.g., 3 Kings at once)
{
  type: "move",
  gameId,
  playerId,
  fromPileId: "P1-hand",
  toPileId: "P1-meld-K",
  cardIds: [42, 43, 44],  // Array of card IDs instead of single cardId
}
```

**Key points:**

- A `MoveIntent` must have **exactly one** of `cardId` or `cardIds` (XOR constraint enforced by schema).
- Use `cardIds` to move multiple cards atomically from the same source to the same destination.
- The engine validates all cards exist in the source pile before calling your rule module.
- Your `validate()` function receives the intent as-is and should validate the complete group.

**Typical implementation pattern:**

```typescript
// In listLegalIntentsForPlayer: Generate multi-card meld candidates
const meldCandidates = generateMeldCandidates(hand, state, playerId);
for (const cardIds of meldCandidates) {
  candidates.push({
    type: "move",
    gameId,
    playerId,
    fromPileId: `${playerId}-hand`,
    toPileId: targetMeldPile,
    cardIds, // Multiple cards
  });
}

// In validate: Handle both single and multi-card moves
if (intent.type === "move") {
  const cardIds =
    intent.cardId !== undefined ? [intent.cardId] : intent.cardIds!;

  // Validate the group as a complete unit
  if (cardIds.length >= 3) {
    // Validate as complete meld (e.g., 3+ same rank, run, etc.)
    const validMeld = validateMeldGroup(cards);
    if (!validMeld) {
      return { valid: false, reason: "Invalid meld", engineEvents: [] };
    }
  }

  // Emit move-cards event with all card IDs
  engineEvents.push({
    type: "move-cards",
    fromPileId: intent.fromPileId,
    toPileId: intent.toPileId,
    cardIds,
  });
}
```

**Benefits:**

- **Reduces AI decision space**: Instead of 30-50 micro-moves, AI sees ~10 meaningful meld choices.
- **Atomic validation**: The complete meld is validated as one unit, preventing invalid partial states.
- **Clearer intent**: Multi-card moves make the player's intention explicit.

**Filtering redundant single-card moves:**

When you generate multi-card candidates, filter out redundant single-card moves for the same cards to the same destination. Otherwise the AI sees both options and may choose the inefficient single-card path.

```typescript
// Track cards already covered by multi-card intents
const cardsCoveredByMultiCard = new Set<number>();

// Generate multi-card candidates first
for (const cardIds of multiCardCandidates) {
  if (this.validate(state, candidate).valid) {
    intents.push(candidate);
    // Mark these cards as covered
    for (const id of cardIds) {
      cardsCoveredByMultiCard.add(id);
    }
  }
}

// Single-card moves: skip cards already covered
for (const card of handCards) {
  if (cardsCoveredByMultiCard.has(card.id)) continue;
  // ... generate single-card move candidates to same destination
}
```

This optimization:

- Reduces candidate count significantly (e.g., 32 → 20)
- Prevents LLM confusion from redundant choices
- Ensures AI picks the efficient multi-card option

**Note:** Only filter single-card moves to the **same destination** as the multi-card intent. Single-card moves to different destinations (e.g., layoffs to opponent's piles in rummy games) should still be offered since they serve a different purpose.

---

## 8. Final checklist

Before calling the new game "done", verify:

- [ ] All edits are limited to:
  - `backend/src/rules/impl/<rulesId>.ts`
  - `backend/src/rules/registry.ts`
  - `rules/<rulesId>/**`
- [ ] No other backend, frontend, or test files changed.
- [ ] `rules/<rulesId>/<rulesId>.initial-state.json` passes schema validation and:
  - [ ] **Deck size is correct** for your game (e.g., 36 for Durak, 52 for Bridge, 40 for Italian games),
  - [ ] every card id appears in exactly one pile,
  - [ ] deck piles have `shuffle: true` when needed.
- [ ] `rules/<rulesId>/<rulesId>.layout*.json`:
  - [ ] all `row`/`col` indices are zero-based and within bounds (rows > maxRow, cols > maxCol),
  - [ ] **every zone has a `piles` property** (even if empty `[]`),
  - [ ] **includes top-level `rulesId`** and validates against `GameLayoutSchema`,
  - [ ] any `widget: "actions"` / `widget: "scoreboards"` zones are intentional
        (only add them when you want in-table widgets beyond the header).
- [ ] Rule module:
  - [ ] uses the pre-move model correctly,
  - [ ] emits `move-cards` for all card movements,
  - [ ] **prefers direct card moves over action buttons** (see section 5.3),
  - [ ] **includes "start-game" in listLegalIntentsForPlayer** when hasDealt is false,
  - [ ] **follows the standard dealing pattern (Option A)** (see section 5.13),
  - [ ] **uses centralized deterministic shuffling** for multi-round games (see section 5.12),
  - [ ] **avoids `undefined` in rulesState** (prefers `null`, see section 5.14),
  - [ ] **includes a required `result: string | null` field** in `rulesState`,
  - [ ] updates `rulesState`, `actions`, and `scoreboards` consistently,
  - [ ] sets `winner` and/or `currentPlayer` when the game ends or turn changes.
- [ ] If using deferred validation, ensure reversible moves (e.g. meld->hand) are implemented and listed in `listLegalIntentsForPlayer`.
- [ ] Plugin is registered in `registry.ts`.
- [ ] `meta.json` exists and matches `<rulesId>`.
- [ ] `npm run lint` and `npm run build` succeed.
- [ ] A basic manual playthrough from start to finish works without runtime errors.

If any of this seems impossible without changing the engine or UI, stop and ask
the user instead of guessing.
