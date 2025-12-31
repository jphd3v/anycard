# Playthrough Generation Prompt

This document provides guidelines for generating playthrough specifications for automated testing.

## Rules for Human-Only Playthrough Generation

1. **Human-only only**: Do not mention AI seats, AI runtime, or AI behavior.
2. **Match seat count**: Set `contexts` based on `rules/<rulesId>/meta.json` (`maxPlayers`).
3. **Use the contract**: Follow `test/e2e/playthroughs/README.md` (YAML frontmatter + step style).
4. **Test mode required**: All `entry` URLs must include `test=1`.
5. **Use only supported UI**: Only reference actions/selectors documented in `test/e2e/MCP_MAPPING.md`.
6. **Keep it short**: Prefer 10–25 steps (deal + 1–3 interactions + a few assertions).
7. **Make steps explicit**: Avoid “it”/“they” references; each step should stand alone.

## Example Structure

```md
---
id: <unique-id>
mode: human-only
contexts: <N> # number of seats/pages required
entry:
  A: "/<rulesId>?reset=1&test=1"
  B: "/<rulesId>?test=1"
  C: "/<rulesId>?test=1"
  D: "/<rulesId>?test=1"
evidence:
  screenshots: true
---

1. [A] Navigate to: /<rulesId>?reset=1&test=1
2. [B] Navigate to: /<rulesId>?test=1
3. [A] Join seat P1
4. [B] Join seat P2
5. [A] Click "Start game / Deal cards"
6. [A] Assert pile-count:P1-hand > 0
```
