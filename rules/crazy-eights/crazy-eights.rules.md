# Crazy Eights (standard, 2 players)

Rules are implemented from https://www.pagat.com/eights/crazy8s.html (Basic Game and Special Cards sections).

## Setup

- A 52-card deck is used.
- The game is fixed to two players; 7 cards are dealt to each player.
- The remaining cards form the stock (face down).
- The top card of the stock is turned face up to start the discard pile.

## Play

On a turn, either:

1. **A legal card is played** to the discard pile, or
2. **One card is drawn** by moving the top card of the stock to the hand (drawing is allowed even if a legal play exists).

Legal plays:

- If the top discard is not an Eight, any card matching rank or suit is played.
- An Eight may be played on any card; a suit is nominated.
- If an Eight is on top, the next card must be an Eight or a card of the nominated suit.

If an Eight is the first discard, a suit is nominated by the dealer before play begins.

## Special Cards

- **Queen (skip)**: When a Queen is played, the next player is skipped. In a two-player game, another turn is taken by the same player.
- **Two (draw)**: When a Two is played, two cards must be drawn by moving the top cards of the stock to the hand, or another Two must be played. Eights cannot be played in this situation. If consecutive Twos are played, the draw penalty is cumulative.

If a special card is the first discard, it is treated as though it was played by the dealer:

- If the first card is a Queen, the first turn is taken by the dealer.
- If the first card is a Two, the first response must be a Two or two cards must be drawn.

If the last card played by the winner is a special card, the special effect is ignored.

## “Last card”

A player who ends a turn with one card must call **Last card** before the next player acts.
If the call is missed, two cards are drawn as a penalty.

## End of Stock

When the stock is exhausted, the discard pile (except the top card) is reshuffled to form a new stock.

## Scoring & Win

When a player gets rid of all cards, that player wins. The opponent’s remaining cards score:

- 50 points for each Eight
- 10 points for each face card (J, Q, K)
- Spot cards at face value; Ace = 1

This implementation ends after a single hand and penalty points are recorded on the scoreboard.

## Game Strategy

- Eights are preserved to change suit at critical moments.
- Suit changes are planned to strand the opponent without a matching suit.
- Hand diversity is maintained to avoid being trapped by a single suit.
