---
id: pinnacola-01-smoke
mode: human-only
contexts: 2
entry:
  A: "/pinnacola?reset=1&test=1&ctx=A"
  B: "/pinnacola?test=1&ctx=B"
evidence:
  screenshots: true
---

# Pinnacola smoke test (human-only)

Contexts:

- A = P1, B = P2

1. [A] Navigate to: /pinnacola?reset=1&test=1&ctx=A
2. [B] Navigate to: /pinnacola?test=1&ctx=B

3. [A] Join seat P1
4. [B] Join seat P2

5. [A] Click "Start game / Deal cards"

Smoke assertions: 10. [A] Assert each seat has a non-empty hand pile (or pile-counts reflect dealing)
