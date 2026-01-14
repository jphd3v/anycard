---
id: marjapussi-01-smoke
mode: human-only
contexts: 4
entry:
  A: "/marjapussi?reset=1&test=1&ctx=A"
  B: "/marjapussi?test=1&ctx=B"
  C: "/marjapussi?test=1&ctx=C"
  D: "/marjapussi?test=1&ctx=D"
evidence:
  screenshots: true
---

# Marjapussi smoke test (human-only)

Contexts:

- A = N, B = E, C = S, D = W (use whatever seat IDs your UI exposes)

1. [A] Navigate to: /marjapussi?reset=1&test=1&ctx=A
2. [B] Navigate to: /marjapussi?test=1&ctx=B
3. [C] Navigate to: /marjapussi?test=1&ctx=C
4. [D] Navigate to: /marjapussi?test=1&ctx=D

5. [A] Join seat N
6. [B] Join seat E
7. [C] Join seat S
8. [D] Join seat W

9. [A] Click "Start game / Deal cards"

Smoke assertions: 10. [A] Assert each seat has a non-empty hand pile (or pile-counts reflect dealing)
