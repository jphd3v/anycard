# Universal Card Game Engine – Architecture

This repository implements a **universal, event-sourced card game engine**.

- `AGENTS.md` – short, “just do this” instructions for agents.
- `ADDING_NEW_GAME.md` – strict, step-by-step instructions for adding a new game.
- `ARCHITECTURE.md` (this file) – how the engine works internally.

If you’re changing the engine, debugging tricky behaviour, or designing new
features, read this end-to-end.

---

## 0. What lives where (big picture)

### Frontend

- Renders a `GameView` plus a layout JSON.
- Sends `ClientIntent`s when the player drags cards or clicks buttons.
- Has **no game-specific logic**; it doesn’t know what “Durak” or “Bridge” is.

### Backend core

- Manages socket.io connections.
- Keeps an **event log** (`GameEvent[]`) per `gameId`.
- Rebuilds the current `GameState` by folding events (`projectState`).
- Dispatches to **game plugins** but is otherwise game-agnostic.

### Rule modules (per game)

- One TypeScript file per game: `backend/src/rules/impl/<rulesId>.ts`.
- Export a `GameRuleModule`:

  ```ts
  interface GameRuleModule {
    validate(state: ValidationState, intent: ClientIntent): ValidationResult;
  }
  ```

- This is the **canonical ruleset** for that game.
- The rule module:
  - Sees a **pre-move** snapshot (`ValidationState`).
  - Decides whether the move is valid.
  - Emits **engine events** to mutate the game (including the actual card moves).

---

## 1. Stateless rule contract (pre-move model)

Rules are pure functions from a pre-move snapshot and an intent to a
`ValidationResult`:

```ts
interface GameRuleModule {
  validate(state: ValidationState, intent: ClientIntent): ValidationResult;
}
```

### 1.1 Inputs

#### `state: ValidationState` – pre-move snapshot

Represents the game **before** the new move is applied:

- No card has moved yet for this intent.
- Built from:
  - `GameState` projected from the event log so far.
  - The full `GameEvent[]` for context.
  - The current `ClientIntent` (used to decide what to reveal).

Consequences:

- If a card is being moved from `fromPileId` to `toPileId`:
  - it is still present in `state.piles[fromPileId]`,
  - it is **not yet** present in `state.piles[toPileId]`.

#### `intent: ClientIntent` – what the player wants to do

Examples:

```ts
// Card move
{
  type: "move",
  gameId,
  playerId,
  fromPileId,
  toPileId,
  cardId,
}

// Button click
{
  type: "action",
  gameId,
  playerId,
  actionId,
}
```

### 1.2 Output: `ValidationResult`

```ts
interface ValidationResult {
  valid: boolean;
  reason?: string | null;
  engineEvents: EngineEvent[];
}
```

Rules must obey:

- If the move is **illegal**:
  - `valid` must be `false`,
  - `engineEvents` must be an empty array,
  - `reason` should explain why (short, human-readable).

- If the move is **legal**:
  - `valid` must be `true`,
  - `engineEvents` must fully describe the consequences:

Minimal guardrails are allowed. Even in multi-step turns, rule modules may block clearly illegal starts when a rule requires a prerequisite (e.g., Canasta's initial meld minimum). Keep these checks small and rule-driven: the goal is to prevent obvious misplays and AI blunders without over-automating the full turn. - the actual card move(s) (`move-cards`), - phase/score/turn changes (`set-rules-state`, `set-current-player`,
`set-scoreboards`, `set-actions`, `set-winner`).

---

## 2. Life of a move (request → rules → events → view)

End-to-end pipeline for a single drag or button click:

```text
Player
  ↓ (drag card / click button)
Frontend (React)
  ↓
Build ClientIntent
  ↓
Socket.io: "game:intent"
  ↓
Backend socket handler
  - zod-validate payload
  - lookup GameState via projectState(gameId)         // PRE-MOVE
  - fetch full GameEvent[] for context
  - run preValidateIntentLocally (basic checks)
  - build ValidationState
  - call plugin.ruleModule.validate(ValidationState, intent)
  ↓
ValidationResult { valid, reason?, engineEvents }
  ↓
Backend applies result
  - if invalid: emit validation + "game:invalid"
  - if valid:
      • check engineEvents with canApplyGameEvent
      • append to event log
      • apply to GameState via applyEvent
      • rebuild GameState via projectState
  ↓
Derive GameView
  - enforce visibility
  - combine with layout.json
  - (GameState has NO layout info; layout.json is the sole source of truth)
  ↓
Socket.io: "game:view"
  ↓
Frontend re-renders everything (piles, scoreboards, actions)
```

Key point: **No automatic events happen before rules run.** Rules are responsible
for _all_ consequences of a valid move.

---

## 3. ValidationState: what rules can see

Rules receive a `ValidationState` instead of the raw `GameState`.

Conceptually:

```ts
export interface ValidationState {
  gameId: string;
  rulesId: string;
  currentPlayer: string | null;
  winner: string | null;

  piles: Record<string, ValidationPileSummary>;
  rulesState: unknown;

  moveIndex: number; // index of this move in the game
  recentEvents: SimplifiedEvent[];
}
```

### 3.1 Piles

`piles[pileId]` is a **summary**:

- `id`
- `ownerId`
- `size`
- `topCard` – visible top card, when appropriate
- `cards` – full descriptors only when:
  - the pile is owned by the acting player (so rules can enumerate their own hidden hand),
  - the pile is public,
  - or it’s a visible “won” pile,
  - or it is directly involved in the current intent,
  - or the engine exposes it explicitly for this game.

Hidden information is preserved:

- You do not get every card in every hand by default.
- Card ids remain observable even for hidden piles; rank/suit may be stripped.

### 3.2 `rulesState`: long-term memory

`rulesState` is owned by the rule module. Use it for:

- phases: `"deal" | "bidding" | "play" | "scoring" | ...`
- scores
- trick/battle state
- broadcasting flags (`hasDealt`, `round`, etc.)
- per-game data structures (melds, contracts, etc.)

Rules treat `rulesState` as immutable input and update it via:

```ts
engineEvents.push({
  type: "set-rules-state",
  rulesState: nextRulesState,
});
```

Anything not written into `rulesState` does not persist to the next move.

### 3.3 `recentEvents`: temporal context

`recentEvents` is a small window into the event log:

- Last N events, simplified.
- Typical fields: `index`, `type`, `playerId`, pile ids, card ids.

Use it for temporal logic:

- “Double only directly after a bid.”
- “Claim only if your last move was X.”

Do not treat it as primary state.

---

## 4. Engine events: the only way to change state

Rule modules never mutate state directly; they emit **engine events**.

Common types:

| Event type            | Purpose                                |
| --------------------- | -------------------------------------- |
| `move-cards`          | Move card ids between piles            |
| `set-current-player`  | Change whose turn it is                |
| `set-winner`          | Mark winner / finish game              |
| `set-rules-state`     | Replace the `rulesState` object        |
| `set-scoreboards`     | Replace scoreboards array              |
| `set-actions`         | Replace action grid                    |
| `set-pile-visibility` | Change a pile’s visibility             |
| `fatal-error`         | Catastrophic failure (engine/AI/rules) |

### 4.1 Pile order and `move-cards` semantics

Piles are ordered stacks. The canonical ordering is `pile.cardIds`.

- `move-cards.cardIds` is treated as a **set of ids** to move.
- When applying a move:
  1. `moving = fromPile.cardIds.filter(id => cardIds.includes(id))`
  2. Remove `moving` from `fromPile.cardIds` in-place.
  3. Append `moving` to `toPile.cardIds`.

This mirrors real-world stacking and keeps order consistent.

---

## 5. The UI trinity: rulesState, actions, scoreboards

The rules control three main levers for the UI:

1. `rulesState` – phases, scores, any game model.
2. `actions` – a grid of buttons the current player can click.
3. `scoreboards` – tables rendered in dedicated scoreboard zones.

The frontend:

- Renders actions as buttons in the `widget: "actions"` zone(s).
- Renders scoreboards as tables in the `widget: "scoreboards"` zone(s).
- Sends `ClientIntent { type: "action", actionId }` when a button is clicked.
- Does not understand game semantics.

Guideline:

> Whenever `rulesState` or `currentPlayer` changes, recompute `actions` and
> `scoreboards` and emit `set-actions` + `set-scoreboards`.

**⚠️ Lifecycle Warning**: Never include the `"start-game"` action in the `actions` grid returned by `deriveActions`. The frontend uses a dedicated `StartGameOverlay` component that appears automatically when `rulesState.hasDealt` is false. Adding it to the grid will result in duplicate buttons or empty placeholders.

- Do **not** seed action buttons in the initial state JSON; keep `rows/cols/cells` empty and
  let the rule module emit `set-actions` (e.g. immediately after `start-game`/dealing).

---

## 6. Game configuration and per-game files

Each game is wired up using a set of configuration and rule files. For
step-by-step instructions, see `ADDING_NEW_GAME.md`. This section explains
what each file _means_.

### 6.1 Initial state: `rules/<rulesId>/<rulesId>.initial-state.json`

Defines:

- players and piles (ids, owners, visibility),
- initial `rulesState` for that game,
- initial `actions` and `scoreboards` (actions should be empty; derive the grid in rules code).

Deck/hand model:

- Deck piles:
  - contain the starting cards,
  - often have `"visibility": "hidden"` and `"shuffle": true`.

- Hand piles per player:
  - start empty,
  - usually `"visibility": "owner"`.

Constraints:

- Every card id appears in exactly one pile.
- The union of pile card ids matches the `cards` object.
- Piles marked `"shuffle": true` are randomized by `applyShuffleToState` using
  the game seed.

#### Hidden piles and draw decks

Hidden information policy:

- Clients see `CardView.id` (opaque, per viewer), not engine card ids.
- Ranks/suits are stripped when not visible.
- This is not a cryptographic boundary; a malicious client can still track
  their own `CardView.id` values over time.

#### Per-card visuals (rotation)

Rules may optionally attach view-only visual hints to specific cards.

- `GameState.cardVisuals` is an optional mapping of `cardId -> { rotationDeg?: number }`.
- The backend includes this in `CardView` as `rotationDeg`, and the frontend rotates the
  rendered card by that many degrees.
- This does not affect gameplay logic (it is purely visual).

Rule modules can update the mapping with the engine event:

- `set-card-visuals` `{ visuals: Record<number, { rotationDeg?: number }> }`

Like `set-actions`, this replaces the full mapping when applied.

Typical drawing pattern:

- Use an `action` intent like `"draw-from-deck"`.
- Let the rule module:
  - read the deck from `ValidationState`,
  - pick the top card,
  - emit a `move-cards` event.

Avoid requiring clients to specify `cardId` for hidden piles.

#### Start-game / dealing

Games that need an initial deal:

- Track a boolean flag (e.g. `hasDealt`) in `rulesState`.
- React to a `"start-game"` action by:
  - emitting dealing `move-cards` events,
  - setting `hasDealt: true` and advancing phase,
  - setting `currentPlayer`, `actions`, `scoreboards`.

The engine never auto-deals; the rules must do it.

The `"start-game"` action is reserved for human seats. The AI system never
sends it, and the backend rejects `"start-game"` from AI seats.

For multi-hand games, rules can end a hand by moving all cards back into the
deck (optionally using a deterministic shuffle), set `hasDealt: false`, and
wait for the next `"start-game"` action.

### 6.2 Layout: `rules/<rulesId>/<rulesId>.layout*.json`

Defines table layout.

- Grid: `rows` × `cols`, zero-based `row`/`col` per zone.
- Zones:
  - either list `piles`, or
  - specify a `widget` (`"actions"` or `"scoreboards"`).

Actions and scoreboards are always available in the top header UI. Usually,
in-table widgets should be avoided in the layout zones. Exception: if a game has
only a single action or a very small action set and the layout has room, include
a small `widget: "actions"` zone on the table for clarity (so players do not
need to toggle the actions panel). For action-heavy games, keep actions in the
header by default. Scoreboards can still be placed on the table when space
allows and they are central to gameplay.

Deck placement:

- Hide decks from layout for games where the stock is not visible.
- Show decks explicitly when the physical game does.

Orientation-specific layouts:

- `*.layout-wide.json` for landscape.
- `*.layout-portrait.json` for portrait.
- Fallback to `*.layout.json` if variant is missing.

View-only sorting:

- A pile style may include a `sort` block with a `default` sorter id and an
  `options` array (`bySuitRank` / `byRank` / `bySuit` / `explicit` with
  `{ rank, suit }` entries). Suit/rank strings must match the game’s cards.
- Sorting is applied **client-side only** to visible piles; backend pile order
  remains canonical. If `includeFaceDown` is not set, piles containing
  face-down cards are left in canonical order. Use `applyToLayouts` to limit a
  sorter to specific pile layouts.
- Enforce rules-required order in the rule module with `move-cards`; the sort
  metadata is just a display hint.

Hand layout default:

- Hands should normally be fanned (`layout: "horizontal"` or `"vertical"`) so players can see all
  cards. Use stacked (`"complete"`) layouts only for intentionally hidden piles (e.g., draw decks)
  or games that truly expose only the top card.

### 6.3 Rule modules: `backend/src/rules/impl/<rulesId>.ts`

Contain the game’s logic, including:

- `validate(state, intent)` – main rule function.
- Derived `rulesState`, `actions`, `scoreboards`, `currentPlayer`, `winner`.
- `listLegalIntentsForPlayer` for AI move enumeration (strongly recommended for AI-ready games; optional if you explicitly do not support AI yet).

Keep rule modules:

- pure (no hidden state outside arguments),
- game-specific,
- responsible for all move consequences.

### 6.4 Registry: `backend/src/rules/registry.ts`

Global registry of game plugins:

- Maps `rulesId` → `GamePlugin`.
- Used to:
  - list games in the lobby,
  - load the right rule module for each game.

### 6.5 Rules docs: `rules/<rulesId>/<rulesId>.rules.md`

Optional, user-facing rules:

- Shown in the UI in a “Rules” tab.
- Not read by the engine.
- Must be kept in sync manually with the actual TypeScript rules.

### 6.6 Metadata: `rules/<rulesId>/meta.json`

Per-game metadata (core fields are loaded by the backend; optional fields are
read by the frontend from `meta.json`):

- `rulesId` (required)
- `gameName` (required)
- `description` (optional)
- `minPlayers` (optional)
- `maxPlayers` (optional)
- `category` (optional)
- `supportsActions` (optional; helps the UI show the Actions header button even
  before actions are emitted)

Used by the lobby and game list.

### 6.7 Assets and deck types

The engine assumes:

- standard 52-card decks (or subsets/multiples),
- suits and ranks that map to the existing card assets.

Custom decks (Uno/Tarot with fundamentally different visuals) are not currently
supported by the renderer.

Card assets live under `frontend/public/cards/` with a fixed naming scheme.
Changing the deck model usually implies frontend work.

### 6.8 Rule modules are intentionally isolated

Design choice:

- Each game’s rule module is self-contained.
- Do not share game-specific helpers across modules yet.
- It is acceptable to duplicate small helpers (“find melds”, “trick winner”).

Later, once patterns are stable across multiple games, we can refactor shared
logic deliberately.

---

## 7. LLM configuration (AI policy only)

Move validation is **pure TypeScript**; the LLM is used only for AI policy:
choosing among legal moves.

Config (via `.env`, read by `backend/src/config.ts`):

- `BACKEND_LLM_ENABLED` – opt-in flag for server-side AI turns (`1` to enable, default `0`).
- `LLM_BASE_URL` – OpenAI-compatible endpoint (LM Studio, Gemini proxy, etc.).
- `LLM_API_KEY` – provider key (or dummy for local).
- `LLM_MODEL` – model name for policy decisions.
- `LLM_TEMPERATURE` – default `0`.
- `LLM_TURN_TIMEOUT_MS` – max wall-clock time per AI move (ms).
- `LLM_POLICY_MODE` – `"llm"` (default) or `"firstCandidate"` for deterministic
  test runs.
- `LLM_SHOW_EXCEPTIONS_IN_FRONTEND` – when `true`, include LLM failure details
  in AI logs and fatal error overlays (default `false`).
  - `0` or negative disables timeout.
  - default `10000`.

- `LLM_MIN_THINK_TIME_MS` – minimum visible think time for AI (ms).
  - default `300`,
  - `0` or negative disables.

To **disable backend AI** (default), keep `BACKEND_LLM_ENABLED` unset or `0`.
When set to `1`, backend AI also requires `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL`; if
either is missing, backend AI stays off and only frontend-sponsored AI (if
enabled) will run.

Legacy validation env vars (`RULE_ENGINE_MODE`, `LLM_VALIDATION_MODEL`, etc.)
are ignored; engine always runs in deterministic code mode.

---

## 8. AI players and legal intent enumeration

### 8.1 Seats and views

- Seats may be human or AI (`seat.isAi = true`).
- AI receives the same `GameView` a human at that seat would see:
  - per-player view,
  - hidden cards remain hidden.
- Frontend AI seats can be toggled on/off like server AI seats. Because the AI
  runs in a browser, it can see hidden information for its seat and therefore
  can be abused by the sponsoring user. The lobby shows a warning banner when
  any frontend AI seats are present so other players are informed. Use backend
  AI when you need stronger trust boundaries.

### 8.2 Rules decide what is legal

AI layer is game-agnostic. It depends on rule modules to say what is legal.

Rule modules implement:

```ts
listLegalIntentsForPlayer(state: ValidationState, playerId: string): ClientIntent[]
```

This is mandatory for games shipped in this repo (optional only for local experiments).

Requirements:

- MUST return only intents that `validate(state, intent)` would accept.
- SHOULD encode all phase/turn restrictions.
- SHOULD be deterministic for a given `(state, playerId)`.

### 8.5 Fireproof Legal Intents (Candidate + Filter Pattern)

To avoid duplicating complex logic between `validate` and `listLegalIntentsForPlayer`, rule modules should follow the **Candidate + Filter** pattern.

1.  **Generation**: The rule module identifies all logically plausible moves based on the physical state (e.g., "any card in hand could potentially be played to the center").
2.  **Filtering**: Each candidate intent is passed through the module's own `validate(state, candidate)` function.
3.  **Enumeration**: Only candidates that return `{ valid: true }` are included in the legal intents list.

This architecture treats `validate` as the **single source of truth** for game rules. It prevents "desync" bugs where the AI is offered a move that the engine subsequently rejects, which is a fatal error for the AI subsystem.

### 8.6 Policy flow

When it’s an AI seat’s turn:

1. Rule module (if implemented) returns `ClientIntent[]` candidates.
2. AI policy model receives candidate ids (summaries are for logs/UI only) and picks one.
   - The policy prompt includes a compact per-seat `GameView` plus optional
     `rules/<rulesId>/<rulesId>.rules.md` content when present.
   - Backend and frontend AI runtimes share the same prompt builder and include
     the same rules markdown payload.
   - The prompt explicitly instructs the model to rely **only** on the provided
     rules/state/candidates and to ignore any external knowledge.
   - The prompt also includes general play heuristics (e.g., avoid wasting high
     cards on a trick you cannot win), but only as guidance that must never
     override the rules/state.
3. Chosen intent goes through the normal validation pipeline.
4. If `validate` rejects it, this is a fatal AI error.

Games that do NOT implement `listLegalIntentsForPlayer` are considered **missing AI support**.
The engine may still allow enabling AI for development/testing via best-effort heuristics
(actions + simple drag-style moves), but behaviour is not guaranteed to respect phases or
special constraints. In this repo, all shipped games must implement `listLegalIntentsForPlayer`;
missing implementations are treated as bugs.

### 8.4 Fatal AI failures and retry

If an AI move fails catastrophically (invalid intent, timeout, etc.):

- Backend emits a `fatal-error` event with `source: "ai"`.
- Frontend shows a full-screen overlay with:
  - “Retry AI move” – re-run one AI turn for the current player,
  - “View AI log” – inspect policy reasoning,
  - “Return to lobby”.

The overlay is for debugging and recovery; normal invalid human moves use
standard validation errors instead.

### 8.7 Agent Guide and History Digest

Rule modules may include a lightweight `agentGuide` object in `rulesState` to
help the AI reason about hard constraints and short-term memory. This is a
**rules-only** hint channel; the engine does not interpret it. For AI-ready
games in this repo, `agentGuide.historyDigest` is required.

Recommended convention:

- `agentGuide.historyDigest`: a simple **array of strings**, ordered oldest to newest.
- Keep entries high-level and compact (e.g., "P2: drew stock, discarded 8C").
- One entry per **completed turn** (or per trick in trick-taking games), not per micro-move.
- Cap both length and count (e.g., max 80–120 chars per entry, keep last 8–12 entries).
- Include only public information; never leak hidden cards or private hands.

### AI policy candidates and output format (DSL)

The AI policy layer is given a **finite list of candidate moves** and must
pick exactly one.

Each candidate has an opaque id and a human-readable summary. Summaries are for
logs/UI only and are not sent to the policy LLM. Conceptually:

```ts
interface AiPolicyCandidate {
  id: string; // opaque, unique within this turn
  summary: string; // short, human-readable
  source: "rules" | "action" | "move"; // conceptual origin
  intent: ClientIntent; // what will be sent back into the rules
}
```

The engine currently uses the following **id naming convention**:

- `rules:<n>`
  - Candidates produced by `listLegalIntentsForPlayer`.
  - Example: `rules:0`, `rules:1`, …

- `candidate:<n>`
  - Fallback candidates derived from the current view when a rules module does
    not implement `listLegalIntentsForPlayer`.
  - Example: `candidate:0`, `candidate:1`, …

**Important design point:** the engine treats `candidate.id` as an **opaque
string**. It does not parse or interpret the `rules:` or `candidate:`
prefixes; they are there for:

- human-readable logs,
- future routing if we ever want to treat different sources differently.

The policy LLM must not invent ids; it must echo one of the provided ids
exactly.

#### Policy output schema (DSL)

The policy model must return a single JSON object of this shape:

```ts
interface AiPolicyOutput {
  chosenCandidateId: string;
}
```

In other words, the response should be:

```json
{ "chosenCandidateId": "rules:0" }
```

The model may include reasoning text, but the final JSON **must** be wrapped in
`<final_json>` tags, and only the JSON inside those tags will be used.

Example:

```text
<final_json>{"chosenCandidateId": "rules:0"}</final_json>
```

- No markdown fences inside the `<final_json>` block.
- No additional fields inside the JSON object.

On the backend, this is enforced by a schema such as:

```ts
const AiPolicyOutputSchema = z.object({
  chosenCandidateId: z.string(),
});
```

and by extracting the **first JSON object** found in the LLM’s raw text
response.

#### Fallback behaviour

When the engine receives the LLM response:

1. It looks for a JSON object inside `<final_json>` tags; if not found, it
   falls back to scanning the response for JSON objects.
2. It validates the result against `AiPolicyOutputSchema`.
3. It finds the candidate whose `id === chosenCandidateId`.

If any of these steps fail (no JSON found, schema mismatch, unknown id),
the engine logs the failure for debugging and treats it as a **fatal AI error**
in normal LLM mode. This stops the AI turn and emits a `fatal-error` event so
the UI can surface the problem.

Deterministic fallback is available only when `LLM_POLICY_MODE=firstCandidate`
for testing; in that mode the AI skips the LLM and always picks a default
candidate (first non-pass if available).

This means:

- The DSL is deliberately **minimal**: one string field.
- The policy layer is **advisory**: a broken or misbehaving model cannot
  corrupt state, only cause us to rely on the fallback.

```

```

---

## 12. Multi-Round Games and Deterministic Shuffling

Many card games (Bridge, Kasino, Scopa, etc.) are played over multiple hands or "deals". The engine provides a standard pattern to handle these transitions robustly and ensure fair randomization.

### 12.1 The "Next Round" Overlay Pattern

To provide a natural break between rounds where players can review scores, use the following pattern in `rulesState`:

1.  **State Flags**:
    - `hasDealt: boolean`: Tracks if the current hand's cards are on the table.
    - `dealNumber: number`: A counter that increments with every full deck deal.
2.  **Round End**:
    - When a hand ends, move all cards back to the `deck` pile (using `move-cards`).
    - Increment `dealNumber`.
    - Set `hasDealt: false`.
    - This state automatically triggers the "Continue to next round" overlay in the frontend.
3.  **Round Start**:
    - The player clicks "Start next round" (sending a `"start-game"` action).
    - The rule module's `validate` function catches `"start-game"` when `hasDealt` is false.
    - **Shuffle**: Use the game `seed` (from `ValidationState`) and the current `dealNumber` to perform a deterministic shuffle of the deck.
    - **Deal**: Emit `move-cards` events to distribute the _shuffled_ cards.
    - Set `hasDealt: true`.

### 12.2 Deterministic Shuffling

Because the engine's default shuffling only happens once at game creation, rule modules are responsible for reshuffling between rounds. To ensure consistency across clients and AI, this shuffle **must be deterministic** based on the game seed.

Standard utility implementation:

```ts
function createRandom(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fisherYates<T>(array: T[], random: () => number): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// In validate('start-game'):
const baseSeed = stringToSeed(state.seed || "GAME_ID");
const random = createRandom(baseSeed + rulesState.dealNumber);
const shuffledCards = fisherYates(deckCards, random);
```

By combining `seed` and `dealNumber`, every round is uniquely randomized but perfectly reproducible.

Shuffle input should be canonical. Avoid building the shuffle list via
`Object.values(state.piles)` or other object-iteration order. Prefer:

- if the `deck` pile currently contains the full deck, use its card order as the
  shuffle input (this preserves seeded scenario expectations for fresh deals);
- otherwise, build the list from `state.allCards` and sort by id so reshuffles
  are deterministic regardless of pile insertion order.

Dealing utilities are available in `backend/src/rules/util/dealing.ts`:

- `gatherAllCards(...)` collects cards back into the deck; pass `previousEvents`
  or `projectedPiles` if you already queued moves so the projection is accurate.
- `shuffleAllCards(...)` performs deterministic shuffling with canonical input.
- `distributeRoundRobin(...)` deals one-by-one in alternating order; use it only
  when the real rules call for round-robin dealing.

Utilities are optional. Use them when they match the game's actual dealing
mechanics, and keep custom dealing when the game requires block dealing or
preserves the remaining deck order.

### 12.3 Dealing Patterns

There are two primary patterns for dealing cards from the deck in a rule module:

#### Pattern A: Direct Deal (Standard)

In this pattern, you calculate the shuffled order in memory and immediately emit `move-cards` events from the `deck` directly to the target hand or table piles.

- **Pros**: Most efficient, cleanest event log, best for current frontend animations (cards fly straight from deck to hand).
- **Current Standard**: All games in this repository should use this pattern.
  The distribution order is still game-specific (round-robin, block dealing, or
  stock order), so do not force a single helper if the rules differ.

#### Pattern B: High-Fidelity Reorder (Alternative)

In this pattern, you first emit a single `move-cards` event from the `deck` back to the `deck` using the shuffled order. Then, you emit distribution events from the deck to hands.

- **Pros**: Explicitly logs the "shuffle" event before the deal begins.
- **Future Use**: May be useful if the frontend later supports specific "shuffling" animations or high-fidelity deck logs.

---

## 13. Common pitfalls

### 9.1 Pre-move confusion

**Symptom:** You check the destination pile for the card and can’t find it.
**Cause:** Rules run in a pre-move model; the card is still in the source pile.
**Fix:** Validate against `state.piles[fromPileId]` and emit `move-cards` yourself.

### 9.2 Forgetting to update actions/scoreboards

**Symptom:** Turn or phase changes but UI buttons/scores don’t.
**Cause:** `set-actions` / `set-scoreboards` not emitted.
**Fix:** Any time `rulesState` or `currentPlayer` changes, recompute and emit both.

Also:

- **Symptom:** You emit `set-scoreboards` / `set-actions`, but nothing shows up.
- **Cause:** Layout has no `widget: "scoreboards"` or `widget: "actions"` zone,
  so nothing is rendered inside the table grid (the header still shows them).
- **Fix:** Add widget zones only if you want in-table widgets; otherwise this is
  expected.

### 9.3 Missing memory

**Symptom:** Scores reset, bidding history disappears.
**Cause:** You changed a local variable but never wrote it back into `rulesState`.
**Fix:** Persist long-lived facts in `rulesState` via `set-rules-state`.

### 9.4 Overusing hidden info

**Symptom:** Rules rely on seeing all hands all the time.
**Cause:** Abusing visibility or stuffing too much into `rulesState`.
**Fix:** Keep games honest; use only information the engine is supposed to know.

### 9.5 Over-engineering the rule module

**Symptom:** Massive state machines, nested mutations, hard-to-follow logic.
**Cause:** Treating rules as a big OO service instead of pure mapping.
**Fix:** Keep rules:

- pure,
- small,
- data-first: read `state`, compute `nextRulesState`, emit events.

---

## 10. Development and debugging tools

- **AI debug log:** When there are AI seats, the current-turn pill in the UI is
  clickable and opens the AI log:
  - shows human-readable traces grouped by “turn”,
  - useful when debugging `listLegalIntentsForPlayer` and AI policy.

- **Fatal error overlay:** Triggered by `fatal-error` engine events, used for
  catastrophic problems (AI, rules, engine). Offers retry/inspect/exit options.

---

## 11. Design Philosophy: Explicit Intent over Automation

When implementing game rules, prefer **Explicit Intent** over **Implicit Automation**.

### 11.1 The Principle

A move should never have a "hidden" meaning that the engine has to guess. If a player's action could result in multiple distinct logical outcomes (e.g., trailing vs. capturing, or building vs. pairing), the rule module should require the player to express that intent explicitly.

This is achieved by using, preferably, the **destination of a move**, or a **specific action button** if moving is not enough to carry the meaning, to encode the goal of the play. Avoid "sweep" logic where a player performs a generic action (like playing to the table) and the engine automatically triggers secondary consequences based on the state.

### 11.2 Example: Fishing Games (Scopa, Kasino)

In "Fishing" games, a player plays a card from their hand.

- **Automated approach (Avoid):** Player moves card to `table`. Engine detects a capture, moves the card and the captured items to `won`.
- **Explicit approach (Preferred):**
  - `listLegalIntentsForPlayer` detects if a capture is possible.
  - If capture is possible, it returns a move to `${playerId}-won`.
  - If no capture is possible, it returns a move to `table`.
  - `validate` enforces that if a capture _can_ be made, the player _must_ move to the `won` pile.

### 11.3 Why?

1. **UI Feedback:** Moving a card directly to its logical destination (like a "Won" pile or a "Build") provides immediate satisfying feedback.
2. **AI Reasoning:** It forces the AI policy to explicitly "choose" its goal, making AI logs much more readable.
3. **Ambiguity Resolution:** It prevents bugs where the engine incorrectly guesses a player's intent in complex situations.
4. **Consistency:** It ensures that all games in a similar category feel and behave the same way.

### 11.4 Advanced Case: Building (Casino)

In variants of Casino that allow **Building**, a single card (e.g., a 4) might have three legal uses:

1. **Trail:** Move the 4 to the table as a loose card.
2. **Pair:** Use the 4 to capture another 4 on the table.
3. **Build:** Combine the 4 with a 6 on the table to create a "Build of 10".

By following the **Explicit Intent** philosophy:

- Trailing is a move to `table`.
- Pairing is a move to `won`.
- Building is either a move to a specific **Build Pile** or an **Action Button** (e.g., "Build 10").

This removes the need for the engine to guess the player's goal and allows the UI to present clear, distinct choices. It also handles "Value Declaration" (e.g., an Ace being 1 or 14) by requiring the player to click the specific action button for the intended value.

The mental model for everything here:

> **Pre-move snapshot → pure rules → engine events → event log → GameView.**

Once that’s internalized, any new feature or game is a controlled mutation of
those steps.

## Supported card game profile (constraints)

This engine is intentionally limited to a specific family of card games.
This section defines what we currently support **without changing the engine
or UI**.

If a new game violates these constraints, it either needs:

- a simplified variant that fits, or
- explicit engine/UI work (not just “add a new game”).

### 1. Deck model

Supported:

- Games built on top of a **standard French 52-card deck**:
  - 4 suits (♠ ♥ ♦ ♣),
  - ranks 2–10, J, Q, K, A.
- Any subset or multiple copies of that deck:
  - e.g. 2 decks for Canasta, reduced decks, etc.
- Up to **two jokers**:
  - we assume the usual **red** and **black** jokers,
  - rules may use 0, 1, or 2 jokers (e.g. only red joker, or both),
  - jokers are treated as regular cards by the engine; rules decide their powers.

Not supported (without engine/UI changes):

- Custom, non-standard decks with their own symbol set:
  - Uno, Tarot, collectible card games, etc.
- Decks that require more than the standard suits/ranks + up to 2 jokers.
- Cards that need arbitrary extra attributes visibly rendered in the UI
  (counters, durability, text boxes, long text, etc.).

You can still encode “special cards” logically in `rulesState`, but their
visual representation is limited to the existing suit/rank/joker assets.

### 2. UI / interaction model

Supported:

- Games that can be expressed with:
  - **piles** of cards (hands, table piles, stock, discard, won piles),
  - **scoreboards** (rectangular tables of numbers/text),
  - **action buttons** (finite sets of choices like bids, passes, “draw”, “start game”).
- Layout expressed as a grid of zones:
  - each zone shows one or more piles, or
  - an actions widget, or
  - a scoreboards widget.
- Interactions that consist of:
  - card moves between piles, and/or
  - clicking action buttons.

Scoreboards:

- The scoreboard system assumes **rectangular tables** (rows × columns).
- We do **not** currently support extremely idiosyncratic historical score
  sheets (for example: the multi-part, specially printed scoreboards used in
  games like Piquet) as first-class objects.
- If such a scoring system can be represented as one or more normal tables,
  or extended in a backwards-compatible way inside the scoreboard system,
  we may model it there in the future.

Not supported (without engine/UI changes):

- Games that require custom widgets:
  - free-form text input,
  - sliders, dials, drawing areas, rich diagrams, timelines, etc.
- Games whose main mechanic is chat/negotiation, not card or button actions.
- Visualisations that can’t be expressed as piles or simple tables:
  - e.g. full board games with arbitrary coordinates and many token types.

If the physical game needs a special UI, we either need to approximate it with
piles/buttons/scoreboards, or do engine/UI work.

### 3. Turn and phase model

Supported:

- **Turn-based** games that can be modeled as a sequence of discrete moves.
- Phases encoded inside `rulesState`:
  - e.g. `"deal"`, `"bidding"`, `"play"`, `"scoring"`.
- Rules that decide:
  - whose turn it is (`currentPlayer`),
  - what is legal now,
  - when a phase or round ends.

Not supported (without engine/UI changes):

- Real-time “twitch” games requiring reaction speed.
- Fully simultaneous action games where order genuinely doesn’t exist:
  - e.g. everyone reveals choices at once and resolution depends on truly
    simultaneous decisions.
  - We can approximate this by modeling “commit” then “reveal” as two phases,
    but not true simultaneity.
- Asynchronous “play whenever over days/weeks” designs with complex timers
  baked into the engine. (You can track round/turn deadlines in `rulesState`,
  but the engine won’t enforce clocks for you.)

### 4. Information model

Supported:

- Hidden information via pile visibility:
  - hands visible only to owners,
  - hidden decks/stock piles,
  - public table and won piles.
- Randomness via shuffling:
  - piles marked `shuffle: true` are shuffled deterministically from the game seed.
- Rules logic that:
  - uses only information the engine exposes in `ValidationState`,
  - persists long-term data in `rulesState`.

#### Card IDs and Visibility

- Engine card IDs (`CardId`) are **server-only**.
- Clients receive `CardView.id`, an **opaque, per-viewer** numeric ID.
  - Derived from a per-game secret salt + the viewer key + the engine card ID.
  - Stable for the same `(gameId, viewerKey, engineCardId)` but not comparable across viewers.
- Client `move` intents use `CardView.id` for `cardId`.
- The server resolves `CardView.id → engine CardId` for that viewer **before** calling rules or applying events.
- Animation events sent to clients also use `CardView.id` so the frontend never needs engine IDs.

**Security posture**

- Treat all client-visible IDs as opaque; never parse or infer meaning from them.

Limitations:

- Hidden information is **not cryptographically secure**:
  - clients can still track their own opaque `CardView.id` values over time,
  - this is fine for casual play and AI, not for adversarial cheaters.
- No built-in support for:
  - secret bidding that must be provably unpeekable,
  - on-chain verification,
  - other “hard security” requirements.

If your game requires strong secrecy or anti-cheat guarantees, the engine
as-is is not enough.

#### Derived data is still data

While the engine automatically hides **card faces** (ranks/suits) in hidden piles
per viewer, it blindly forwards `scoreboards` and `rulesState` to all clients.

- **Risk:** If you calculate points based on a player's private hand, such as "Deadwood" points in Gin Rummy for example,
  and write it into a scoreboard, **every opponent can see it** by inspecting
  the `game:view` payload, even if the UI doesn't render it.
- **Mitigation:** Use `deriveScoreboardsForView(state, viewerId)` in your rule
  module to compute sanitized scoreboards for each viewer (e.g. showing "—" for
  opponents' secret values).
- **Rule:** Do not store private derived data in `rulesState` if that state is
  sent to clients. Store it only if it is public knowledge, or compute it
  dynamically per-view.

### 5. Choices, bids, and numeric input

Supported:

- Finite choice sets exposed as buttons:
  - e.g. discrete bids, “pass”, “double”, “redouble”, “draw”, etc.
- Scoring and accounting handled by:
  - updating `rulesState`,
  - emitting new scoreboards.

Not supported (without engine/UI changes):

- Free-form numeric input from players (e.g. “type any number as a bid”).
- Arbitrary text input (“name your contract in words”).
- Score systems that require arbitrary, per-move numeric entry by the player
  outside the finite set of actions.

Anything the player can choose must be representable as a finite action ID or a
card move, not an arbitrary string/number entered on the client.

### 6. Tokens, boards, and non-card objects

Supported (with modeling tricks):

- Some “token-like” concepts encoded as special cards:
  - you can treat a token/marker as a card that lives in a pile.
- Simple “board” states encoded in `rulesState` and mirrored in scoreboards.

Not supported (without engine/UI changes):

- Games whose core is a **spatial board** with arbitrary coordinates and many
  piece types (chess, Go, etc.).
- Games with many non-card components that must be rendered distinctly:
  - dice, meeples, multi-track boards.

You can fake simple things as “cards in piles”, but beyond that we’re outside
this engine’s scope.

### 7. Betting, stakes, and gambling-style games

Important policy constraint:

- We do **not** support games that **require placing real bets**:
  - no money, chips, or betting tokens with engine-level semantics,
  - no pot management as a first-class concept in the engine.
- This includes “pure betting games” like casino-style poker or blackjack
  where the core loop is stake → deal → resolve → pay out.

These games are extremely popular and already have many dedicated
implementations. For this engine, they are not a priority and are treated as
a different category (“betting games” rather than “card games”) in terms of
focus.

We can still support:

- **Betless** variants of such games:
  - e.g. “poker without betting” where you simply score hands,
  - blackjack-like games where the goal is to get as close to 21 as possible
    and points are tracked on a scoreboard.
- Approximating “stakes” purely as:
  - scoreboard values, and
  - action labels (“call”, “fold”, etc.) with no real currency involved.

If a design requires real, persistent betting tokens or money-like flow, that
is outside the current scope of the engine.

### 8. Special table layouts and geometric formations

Supported:

- Layouts built from **rectangular grid zones** with piles and widgets.
- Reasonably creative arrangements of piles within those zones, using pile
  layout styles to hint at structure.

Not directly supported:

- Games whose rules depend on cards being laid out in a **specific geometric
  shape** that the engine does not model:
  - e.g. certain traditional games (like the Finnish game _Sika_) where cards
    are arranged in a circle or other non-grid formations on the table.
- Exact geometric relationships such as:
  - “left neighbour in a circle”,
  - “distance along a track”,
  - “physical adjacency” beyond what we can model as separate piles.

Most of these games could potentially be **represented approximately** by an
innovative use of pile layout styles and multiple piles (e.g. a ring of piles
visually forming a rough circle), but there is no engine-level concept of
“circle” or “track”.

If the exact geometry is critical to the rules and not just to aesthetics,
we treat that as an engine/UI change rather than a simple new game.
