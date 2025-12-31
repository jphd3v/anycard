---
id: canasta-01-smoke
mode: human-only
contexts: 4
entry:
  A: "/canasta?reset=1&test=1&ctx=A"
  B: "/canasta?test=1&ctx=B"
  C: "/canasta?test=1&ctx=C"
  D: "/canasta?test=1&ctx=D"
evidence:
  screenshots: true
---

# Canasta smoke test (human-only)

Contexts:

- A = P1, B = P2, C = P3, D = P4 (use whatever seat IDs your UI exposes)

1. [A] Navigate to: /canasta?reset=1&test=1&ctx=A
2. [B] Navigate to: /canasta?test=1&ctx=B
3. [C] Navigate to: /canasta?test=1&ctx=C
4. [D] Navigate to: /canasta?test=1&ctx=D

5. [A] Join seat P1
6. [B] Join seat P2
7. [C] Join seat P3
8. [D] Join seat P4

9. [A] Click "Start game / Deal cards"

Smoke assertions: 10. [A] Assert each seat has a non-empty hand pile (or pile-counts reflect dealing)
