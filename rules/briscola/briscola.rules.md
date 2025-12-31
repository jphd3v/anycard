## Overview

Briscola is a popular Italian trick-taking card game for two players, based on [rules on Pagat.com](https://www.pagat.com/aceten/briscola.html#two). The objective is to collect cards worth the most points through strategic play and trick-taking.

## Setup

- **Deck**: 40-card Italian/Spanish-style deck (A, 3, K, Q, J, 7, 6, 5, 4, 2 in ♣️ Clubs, ♦️ Diamonds, ♥️ Hearts, ♠️ Spades).
- **Ranking**: A (high), 3, K, Q, J, 7, 6, 5, 4, 2 (low).
- **Players**: 2 players.
- **Deal**: Each player receives 3 cards. The next card is flipped face-up and placed under the remaining Deck to determine the **Trump Suit**. This card is the last card to be drawn from the Deck.

## Turn Structure

1. **Initial Deal**: Each player receives 3 cards, and one card is flipped as the trump card.
2. **Play Phase**: Players alternate playing one card to the Trick pile. The non-dealer leads the first trick.
3. **Trick Resolution**: The winner of each trick takes all cards in that trick and leads the next one.
4. **Card Drawing**: After each trick, players draw one card from the Deck (winner draws first) until the Deck and the flipped trump card are exhausted.
5. **Game End**: When all cards have been played and captured, the deal ends and points are totaled.

## Card Ranking and Points

### Point Values

- **Ace (A)**: 11 points
- **Three (3)**: 10 points
- **King (K)**: 4 points
- **Queen (Q)**: 3 points
- **Jack (J)**: 2 points
- **All other cards** (7, 6, 5, 4, 2): 0 points

### Rank Hierarchy (for trick winning)

- **Highest to Lowest**: A, 3, K, Q, J, 7, 6, 5, 4, 2.
- **Trump suit**: Cards of the trump suit outrank all non-trump cards.

## Trick Taking Rules

1. **Leading**: The winner of the previous trick leads with any card from their hand.
2. **Following**: The second player may play **any** card from their hand. There is **no obligation** to follow suit or to play a trump card.
3. **Winning**:
   - If any trump cards were played, the highest-ranking trump wins the trick.
   - If no trump cards were played, the highest card in the lead suit wins.
   - If neither card is a trump and the second card is not of the lead suit, the first card wins.

## Scoring and Winning

- Players collect all cards from tricks they win.
- At the end of each deal, players count the points from their captured cards.
- The player with at least **61 points** wins the deal. If both have 60, it's a draw.
- **Total points in deck**: 120 points.

## Multi-Round Play

In this implementation, the game can be played over multiple deals. After each deal, the cards are reshuffled and a new round begins, allowing players to continue competing and tracking their cumulative capture performance.

## Game Strategy

1. **Trump Management**: Save your high trump cards for important tricks where many points are at stake.
2. **Point Cards**: Prioritize capturing high-point cards (A, 3, K, Q, J) when possible, especially if the opponent leads them.
3. **Lead Selection**: Leading with a low-value non-trump card is often a safe way to test your opponent's hand without risking your own high-point cards.
4. **Drawing Order**: Remember that the winner of the trick draws first. This is crucial when the Deck is nearly empty, as the winner might draw a better card (or the known trump card at the bottom).
