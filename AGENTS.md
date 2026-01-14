# AGENTS

This repository is edited by humans and automated coding agents.

This file tells agents **how to behave** and **which docs to follow** for
different kinds of tasks.

There are two big modes of operation:

1. **Engine / architecture / UI work** – change how the universal engine works.
2. **Add a new card game** – plug in a new game, without changing the engine.

These modes are handled differently and you **must not mix them**.

---

## 1. Mental model of the repo

Short version:

- The backend is an **event-sourced universal card engine**.
- Each game is a **plugin**:
  - one TypeScript rule module under `backend/src/rules/impl/`,
  - one config folder under `rules/<rulesId>/`.
- The frontend is generic:
  - it renders cards, piles, scoreboards, and action buttons based on data,
  - it has zero knowledge of specific games.

The details live in:

- `ARCHITECTURE.md` – how the engine actually works.
- `ADDING_NEW_GAME.md` – strict “how to add a game plugin” guide.

Before doing non-trivial work, skim both.

---

## 2. Doc map (what to read when)

**Always available docs:**

- `README.md` – high-level “what is this project”.
- `ARCHITECTURE.md` – how the engine works (backend, frontend, AI, events).
- `ADDING_NEW_GAME.md` – how to add a new game as a plugin.
- `CONTRIBUTING.md` – project-level conventions (if present).

**When your task mentions:**

- _“fix bug”, “improve engine”, “reduce flicker”, “add AI feature”, “change layout system”_  
  → primary doc: `ARCHITECTURE.md`.

- _“add a new game”, “implement game X (Canasta, etc.)”, “make X playable”_  
  → primary doc: `ADDING_NEW_GAME.md`.  
  In this mode, your job is a **game plugin** only, not engine work.

If the assignment is ambiguous between “engine change” vs “new game”, you should
assume it is **engine change** unless the user explicitly says
“use the existing engine as-is” or “do not touch the engine”.

---

## 3. Global rules for all agents

These rules apply to **every task**, regardless of mode.

1. **Think first, then code**
   - Write a short plan: what you will change, which files, and why.
   - Keep changes minimal and coherent: small, targeted edits.

2. **Respect the universal engine**
   - Engine and frontend are **game-agnostic**.
   - Never hardcode game-specific logic in shared code unless explicitly asked.
   - Game rules and metadata belong in per-game modules and `rules/<rulesId>/`.

3. **Don’t silently create new concepts**
   - No new env vars, event types, or global config keys without explicit task.
   - No new cross-cutting abstractions unless the user asked for refactoring.

4. **Follow existing docs over code guesswork**
   - If `ARCHITECTURE.md` says X and some code looks like Y, treat X as the
     design goal and propose to align the code with it (not the other way round).

5. **Ask instead of guessing**
   - If you are not sure about the spec, **stop and ask the user**.
   - Do not “just implement what seems nicer” when behaviour is ambiguous.

6. **Keep diffs readable**
   - Do not format or reorder an entire file just to touch one function.
   - Avoid massive “drive-by” refactors unless explicitly asked.

7. **Run checks**
   - **Philosophy:** Because LLMs and coding agents are non-deterministic by nature, we rely on rigorous, deterministic checks (linting, type checking, security scanning, and automated tests) to ensure codebase stability. These checks act as the "grounding" for AI-generated code.
   - After changes, you MUST run `npm run verify` from the root. This script
     runs linting, type checking, building, integration tests, and a security scan.
   - Any task is only considered complete once `npm run verify` passes
     successfully.
   - If you can’t run something, say so and explain what you would have run.

8. **Deterministic Shuffling for Multi-Round Games**
   - In games with multiple deals or rounds, rule modules MUST implement
     deterministic shuffling using the game `seed` (from `ValidationState`) and
     `dealNumber` (in `rulesState`).
   - The engine's automatic shuffle only happens once at game creation.
   - Reshuffling between rounds is the responsibility of the rule module to
     ensure fairness and consistency across all clients and AI seats.
   - See `ARCHITECTURE.md` (Section 12) for the standard implementation pattern.

---

## 4. Special mode: “Add a new card game”

This is a **special, constrained mode**.

You are in this mode when the assignment clearly says something like:

- “Add a new game X (e.g. Canasta) using this engine.”
- “Implement rules for game X as a plugin.”
- “Make X playable with the existing universal engine.”
- “Do not modify the engine, just add the new game.”

### 4.1 Mandatory doc in this mode

Before writing any code:

- Read `ADDING_NEW_GAME.md` fully.
- Follow it **literally** unless the user explicitly overrides something.

That document is the **single source of truth** for “add a new game” tasks.
Also consult the “Supported card game profile (constraints)” section in
`ARCHITECTURE.md` when checking whether a proposed game is compatible with
the engine.

### 4.2 Hard constraints in “new game” mode

In this mode:

- ✅ You MAY:
  - add a new rule module under `backend/src/rules/impl/<rulesId>.ts`,
  - create a new folder `rules/<rulesId>/` and files inside it,
  - register your plugin in `backend/src/rules/registry.ts`,
  - add optional per-game rules markdown `rules/<rulesId>/<rulesId>.rules.md`.

- ❌ You MUST NOT:
  - change shared engine code in `backend/src` outside:
    - `backend/src/rules/impl/<rulesId>.ts`,
    - `backend/src/rules/registry.ts`,
  - change frontend components or layout system,
  - add new engine event types,
  - change validation pipeline, AI infrastructure, or socket/gateway logic,
  - add dependencies or env vars,
  - modify other games’ rule files unless specifically asked.

### 4.2.1 Use other games as inspiration (no dependencies)

When adding a new game, you are encouraged to look at other existing games for
synergies, examples, and implementation ideas. However, each game remains an
independent unit:

- Do not introduce dependencies, shared code, or references between games.
- Do not import or reuse rules state, layout, or assets across games.
- Keep all knowledge and data within the new game's module and `rules/<rulesId>/`.

Examples:

- For rummy-style games, `canasta` is a good reference for melding and wild
  cards.
- For trick-taking games (especially with an auction phase, actions for bids,
  multiple phases, and more involved scoring/rounds), `bridge` is a strong
  reference.

If you think the game **cannot** be implemented within these constraints,
**stop and ask the user** instead of loosening the rules.

### 4.3 Pre-check the game’s feasibility

`ADDING_NEW_GAME.md` contains a pre-check routine. You must:

- Check:
  - deck model (standard 52-card deck / subset / multiples),
  - UI model (piles + scoreboards + action buttons),
  - turn/phase model (discrete moves, not real-time chaos).
- If the game needs:
  - a completely new card type,
  - a new UI widget beyond piles/scoreboards/buttons,
  - fundamentally different flow than simple turn-based moves,

then summarise the issue and ask the user for guidance or a simplified variant.

Do **not** solve this by hacking the engine or frontend in this mode.

### 4.4 Implementation steps (summary)

The full details are in `ADDING_NEW_GAME.md`. Short version, do them in
this order:

1. **Create per-game folder**
   - `rules/<rulesId>/meta.json`
   - `rules/<rulesId>/<rulesId>.initial-state.json`
   - `rules/<rulesId>/<rulesId>.layout.json` (and optional `layout-wide`, `layout-portrait`)
   - Optional: `rules/<rulesId>/<rulesId>.rules.md` (human-readable rules).

2. **Implement rule module**
   - `backend/src/rules/impl/<rulesId>.ts`
   - Implement a `GameRuleModule.validate(state, intent)` using the **pre-move**
     model described in `ARCHITECTURE.md`.
   - Emit engine events (`move-cards`, `set-rules-state`, `set-actions`,
     `set-scoreboards`, `set-current-player`, `set-winner`).
   - Use `rulesState` to track phases, scores, and long-lived info.

3. **Register the plugin**
   - Add your `<rulesId>` plugin to `backend/src/rules/registry.ts`.

4. **Self-check**
   - Run build/lint.
   - Manually walk a basic playthrough.
   - Check your changes obey the file-scope constraints above.

### 4.5 When to stop and escalate

In this mode, **stop and ask the user** if:

- Implementing the game seems to require:
  - changes to core engine or frontend,
  - new env vars or system-wide configuration,
  - new engine event types or schema changes.
- The game’s rules conflict with the pre-move model.
- Hidden-information requirements conflict with the current visibility model.

Do not silently pivot out of “new game” mode; report the limitation instead.

---

## 5. Engine / architecture / UI changes

You are in this mode when the assignment is things like:

- “Fix the flickering when dealing cards.”
- “Change how animations group events.”
- “Improve AI move retry behaviour.”
- “Add game URLs like `/bridge` or `/durak` for manual testing.”
- “Tighten security for hosted environments.”
- “Refactor rule validation to remove legacy post-move logic.”

### 5.1 Mandatory doc in this mode

Before structural changes:

- Read the relevant sections of `ARCHITECTURE.md`:
  - pre-move model,
  - life of a move,
  - engine events,
  - UI layout and widgets,
  - AI integration.

If your change touches a concept described there, you must keep the code and doc
consistent, or explicitly update both.

### 5.2 Design rules in engine mode

- **Keep the engine universal**
  - Shared code must not know about specific games.
  - No special-case branches like `if (rulesId === "bridge")` in generic layers.
  - If you need game-specific behaviour, push it into per-game rule modules.

- **Prefer explicit, minimal interfaces**
  - Add well-defined configuration and event types instead of free-form blobs.
  - When adding new engine events, describe them in `ARCHITECTURE.md`.

- **Respect pre-move model**
  - Do not reintroduce post-move semantics.
  - Rules always see a snapshot **before** the current move is applied.
  - All consequences of a legal move must be expressed as engine events.

- **Avoid breaking existing games**
  - When possible, change APIs in a backwards-compatible way and then migrate
    individual games.
    - If you must break something, clearly describe what changes existing rule
      modules need.
  - **AI policy DSL is fixed and minimal**
    - The AI policy model must continue to return a single JSON object of the
      form `{ "chosenPickId": "<pickId>" }`.
    - Candidate ids are opaque strings (e.g. `rules:0`, `action:pass`,
      `move:P1-hand:37->table`). Do not introduce new parsing logic for these
      ids in the engine; if you need more structure, add it explicitly to the
      candidate metadata.
    - If you change `AiPolicyOutputSchema` or the policy prompt, you must
      update the “AI policy candidates and output format (DSL)” section in
      `ARCHITECTURE.md` to match.

### 5.3 Typical workflow in engine mode

1. **Understand the bug/feature**
   - Read the user’s description plus relevant code.
   - Locate the part of the pipeline involved:
     - socket handler,
     - state projection,
     - rule module,
     - event application,
     - view derivation,
     - frontend view.

2. **Plan**
   - Decide the smallest change that fixes the issue.
   - Verify it is consistent with the architecture described in `ARCHITECTURE.md`.

3. **Implement**
   - Keep changes tight and scoped.
   - Update `ARCHITECTURE.md` if you change core concepts, event types, or
     behaviour.

4. **Verify**
   - Run tests/lints/build.
   - If possible, outline how you’d manually reproduce and verify the fix.

---

## 6. Refactoring and cleanup tasks

When the task is clearly “refactor”, “rename”, or “cleanup” (no net new
behaviour):

- Preserve behaviour unless otherwise specified.
- Prioritise:
  - removing dead code,
  - clarifying data flow,
  - aligning code with documented architecture,
  - reducing confusion (e.g. deleting leftover post-move references).

Never silently weaken invariants or make subtle behavioural changes under the
label of “cleanup”.

---

## 7. Things you must never do

Regardless of task:

- Do not:
  - push game-specific hacks into shared engine/frontend code,
  - replace data-driven layouts with game-specific conditionals,
  - introduce large dependencies without explicit user request,
  - perform massive, repo-wide formatting or renaming “just because”.

- Do not:
  - reintroduce LLM-based move validation – rules are authoritative and
    deterministic code now.
  - break the pre-move model.

If you feel tempted to do any of the above, that’s your cue to stop and ask the
user.

---

## 8. Summary

- Use **`ADDING_NEW_GAME.md`** when implementing a new game plugin,
  and obey its strict constraints.
- Use **`ARCHITECTURE.md`** when touching the engine, UI, or AI infrastructure.
- Keep the engine:
  - **universal** (no per-game hacks),
  - **event-sourced**,
  - **pre-move** in its rule model.
- When in doubt, **don’t guess** – explain the trade-offs and ask the user.

If you follow this, you can safely operate on this repo in zero-shot mode
without gradually turning the engine into a pile of per-game special cases.
