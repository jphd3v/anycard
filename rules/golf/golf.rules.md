# Golf (4-Card) – Two Players

This implementation follows the 4-card Golf rules from Pagat.

## Setup

- Standard 52-card deck.
- 2 players, 4 cards each laid face down in a 2×2 grid.
- The top card of the stock is turned face up to start the discard pile.
- Each player may look once at the two nearest cards of their layout.

## Turn

On your turn you must either:

- Draw the top card of the stock, then either:
  - replace one of your four layout cards (discarding the replaced card face up), or
  - discard the drawn card face up;
- Or take the top card of the discard pile and replace one of your layout cards
  (you cannot discard it immediately);
- Or knock to end the hand (others get one final turn).

You may not look at your face-down layout cards before choosing which position
will be replaced.

## End of the Hand

- If a player knocks, each other player takes one final normal turn.
- Then all layouts are scored.

## Scoring (per card)

- Ace = 1
- 2–10 = face value
- Jack, Queen = 10
- King = 0

The lowest total after nine deals wins.

## UI Notes

- After the deal, each player may look at their two nearest cards and then click
  **Ready**. This hides those cards again, approximating the one-time peek.
- All layout cards remain face down during play; only the drawn card is shown
  to the active player.
- Drawing from the stock or discard is done by moving the top card to your draw
  slot.
