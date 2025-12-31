# Contributing

Thanks for your interest in AnyCard! This guide is intentionally short and
points you to the authoritative docs to avoid duplication.

## Start here (pick the right doc)

- **Engine / architecture / UI changes**
  - Read `ARCHITECTURE.md` end-to-end.
  - This is the single source of truth for engine behavior and concepts.
- **Add a new game (plugin only)**
  - Read `ADDING_NEW_GAME.md` and follow it literally.
  - Do not change engine or frontend code unless explicitly asked.
- **Using coding agents**
  - Read `AGENTS.md` for the agent-specific workflow and constraints.

If the task is ambiguous between engine changes and adding a game, treat it as
an engine change and read `ARCHITECTURE.md`.

## Workflow expectations

- Keep changes minimal and scoped; avoid repo-wide formatting or refactors.
- Do not introduce new engine event types, schemas, or env vars without an
  explicit request.
- After changes, run the relevant checks from `package.json` (lint/build/tests)
  when practical, and report what you ran.

## Questions or uncertainty

If the requirements are unclear or seem to conflict with the docs above, stop
and ask before making assumptions.
