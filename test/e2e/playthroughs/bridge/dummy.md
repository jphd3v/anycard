---
id: bridge-dummy-reveal
mode: human-only
contexts: 4
entry:
  A: "/bridge?reset=1&test=1&ctx=A"
  B: "/bridge?test=1&ctx=B"
  C: "/bridge?test=1&ctx=C"
  D: "/bridge?test=1&ctx=D"
evidence:
  screenshots: true
---

# Bridge playthrough: dummy reveal + declarer control (human-only)

Contexts:

- A = P1, B = P2, C = P3, D = P4 (use whatever seat IDs your UI exposes)

1. [A] Navigate to: /bridge?reset=1&test=1&ctx=A
2. [B] Navigate to: /bridge?test=1&ctx=B
3. [C] Navigate to: /bridge?test=1&ctx=C
4. [D] Navigate to: /bridge?test=1&ctx=D

5. [A] Join seat P1
6. [B] Join seat P2
7. [C] Join seat P3
8. [D] Join seat P4

9. [A] Click "Start game / Deal cards"

Smoke assertions: 10. [A] Assert each seat has a non-empty hand pile (or pile-counts reflect dealing)

(If bidding UI is stable in your app, extend:) 11. Execute a trivial auction (e.g. 1♠ then 3 passes) using action buttons 12. [leader] Play one card to trick 13. Assert dummy hand becomes visible to all 14. Assert only declarer can play from dummy
