---
id: kasino-01-smoke
mode: human-only
contexts: 2
entry:
  A: "/kasino?reset=1&test=1&ctx=A"
  B: "/kasino?test=1&ctx=B"
evidence:
  screenshots: true
---

# Kasino smoke test (human-only)

Contexts:

- A = P1, B = P2 (use whatever seat IDs your UI exposes)

1. [A] Navigate to: /kasino?reset=1&test=1&ctx=A
2. [B] Navigate to: /kasino?test=1&ctx=B

3. [A] Join seat P1
4. [B] Join seat P2

5. [A] Click "Start game / Deal cards"

Smoke assertions: 6. [A] Assert each seat has a non-empty hand pile (or pile-counts reflect dealing)
