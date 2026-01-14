# Playthrough Specs (BDD)

Playthroughs are Markdown files under `test/e2e/playthroughs/**` intended to be:

- human-readable (humans + LLMs can co-author them),
- executable by a black-box browser runner (MCP) using only the rendered page.

## YAML frontmatter (required)

Every playthrough file MUST start with YAML frontmatter.

Required keys:

- `id`: unique string (used for evidence filenames)
- `mode`: `"human-only"` (only supported mode)
- `contexts`: number of browser pages/contexts (1–4)
- `entry`: per-context URL paths (no host), e.g.
  - `A: "/bridge?reset=1&test=1"`
  - `B: "/bridge?test=1"`

Optional keys:

- `evidence.screenshots`: `true` (recommended)

Rules:

- All playthroughs are human-only; do not mention AI seats/runtime.
- All `entry` URLs MUST include `test=1`.
- If `contexts: N`, `entry` must contain keys `A..` up to that count.
- For dedicated lobby routes (e.g. `/bridge`), prefer `entry.A` to include `reset=1` for a fresh start.
- `contexts` should match the game’s seat count from `rules/<rulesId>/meta.json` (`players`).
- Recommended: include `ctx=A|B|C|D` in each `entry` URL so pages are labeled in the TestHUD + page title.

## Step style

- Use numbered steps.
- Prefix steps with `[A]`, `[B]`, `[C]`, `[D]` for multi-page scenarios.
- Keep vocabulary small and explicit: **Navigate**, **Join seat**, **Click**, **Assert**.
- Prefer assertions against `testhud:*` and `pile-count:*` selectors (see `test/e2e/MCP_MAPPING.md`).

## Example

```md
---
id: bridge-01-basic
mode: human-only
contexts: 2
entry:
  A: "/bridge?reset=1&test=1&ctx=A"
  B: "/bridge?test=1&ctx=B"
evidence:
  screenshots: true
---

1. [A] Navigate to: /bridge?reset=1&test=1&ctx=A
2. [B] Navigate to: /bridge?test=1&ctx=B
3. [A] Join seat P1
4. [B] Join seat P2
5. [A] Click "Start game / Deal cards"
6. [A] Assert pile-count:P1-hand == 26
```
