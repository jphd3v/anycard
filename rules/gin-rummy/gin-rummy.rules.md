## Overview

Two-player Gin Rummy using a standard 52-card deck, based on the [rules on Pagat.com](https://www.pagat.com/rummy/ginrummy.html). Players draw and discard to create melds while minimizing deadwood (unmatched cards). A full match is played to 100 points across multiple hands.

## Setup

- **Deck**: Standard 52-card deck (A, 2, 3, 4, 5, 6, 7, 8, 9, 10, J, Q, K in clubs ♣️, diamonds ♦️, hearts ♥️, spades ♠️).
- **Ranking**: For runs, Ace is low only (A-2-3). Ranks are: A 2 3 4 5 6 7 8 9 10 J Q K.
- **Dealing**: 10 cards to each player. One card is turned face-up (the "upcard") to start the discard pile.
- **First Deal**: The player who draws the higher card deals. Thereafter, the loser of each hand deals the next.
- **Shared Piles**: `discard` pile (face-up), `deck` pile (face-down stock).

## Turn Structure

### The Start of a Hand

The first turn has a special sequence regarding the initial upcard:

1. **Non-dealer** has the first option to take the upcard. If they take it, they must discard to end their turn.
2. If the non-dealer passes, the **dealer** may take the upcard.
3. If both pass, the **non-dealer** draws the top card from the deck and the game continues normally.

### Normal Turns

Each turn follows a two-phase sequence:

**Phase 1: Draw**
You must start your turn by drawing one card:

- **Draw from deck**: Take the top card from the face-down stock.
- **Take discard**: Take the top card from the discard pile (except on the very first turn if you just passed as dealer).
  _Note: If you draw from the discard pile, you cannot discard that same card in the same turn._

**Phase 2: Discard & Ending**
After drawing, you must discard one card. You may then:

- **Discard**: Simply end your turn by placing a card on the discard pile.
- **Knock**: If your deadwood points are 10 or less (after discarding), you may choose to "Knock" to end the hand.
- **Gin**: If you have 0 deadwood points (after discarding), you "Go Gin" to end the hand.

## Knocking, Gin & Laying Off

### Gin (Perfect Hand)

- **Requirement**: Exactly 0 deadwood points.
- **Scoring**: Knocker scores a 25-point bonus plus the opponent's total deadwood.
- **Layoff**: The opponent cannot lay off cards against a Gin.

### Knock (Good Hand)

- **Requirement**: 10 or fewer deadwood points.
- **Layoff**: The opponent may lay off their own deadwood cards onto the knocker's melds (e.g., adding a 4th King to the knocker's set of three Kings).
- **Scoring**:
  - If the knocker's deadwood is less than the opponent's (after layoffs), the knocker scores the difference.
  - **Undercut**: If the opponent has equal or less deadwood than the knocker, the opponent scores the difference plus a 25-point bonus.

### Deadwood Calculation

- **Card values**: Ace = 1, 2-10 = face value, J/Q/K = 10.
- **Melds**:
  - **Sets**: 3 or 4 cards of the same rank.
  - **Runs**: 3 or more cards in sequence of the same suit (Ace is low).

### Blocked Hand

If only 2 cards remain in the deck and no one has knocked, the hand is cancelled and no points are awarded. The same dealer deals again.

## Match Scoring

A match ends when a player reaches **100 points**.

### Bonuses

- **Game Bonus**: 100 points for winning the match.
- **Box Bonus**: 25 points for every hand won during the match.
- **Shutout (Schneid)**: If the loser won zero hands, all bonuses (Game and Box) are doubled.

## Game Strategy

- **Early Knocking**: Knocking early can catch an opponent with high-value deadwood.
- **Holding for Gin**: If your deadwood is very low, it might be worth waiting for Gin to avoid being undercut.
- **Discard Tracking**: Watch what your opponent takes from the discard pile to avoid giving them the cards they need.
