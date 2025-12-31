## Overview

Full **Rubber Bridge** for four players in fixed partnerships (North+South vs East+West), based on the [official rules on Pagat.com](https://www.pagat.com/auctionwhist/bridge.html#rubber). This implementation follows the traditional rubber format where the first side to win two games wins the rubber.

## Setup

- **Deck**: Standard 52-card deck.
- **Ranking**: Aces high (A K Q J 10 9 8 7 6 5 4 3 2).
- **Players**: 4 players in fixed partnerships: **North & South vs East & West**.
- **Dealing**: 13 cards are dealt to each player.
- **Vulnerability**: A side becomes "vulnerable" after winning its first game, which increases both bonuses and penalties for that side.

## Turn Structure

The game progresses through three distinct phases:

### Phase 1: Bidding (The Auction)

Players make calls in rotation starting from the dealer:

- **Bids**: 1♣️ through 7NT. Each bid must outrank the previous one (higher level, or same level with higher suit: ♣️ < ♦️ < ♥️ < ♠️ < NT).
- **Pass**: Skip the turn. The auction ends after three consecutive passes (or four if no one bids).
- **Double**: Can be used on an opponent's bid to increase the stakes.
- **Redouble**: Can be used on an opponent's double to increase the stakes even further.

### Phase 2: Trick Play

- **Opening lead**: The player to the left of the declarer leads.
- **Dummy**: The declarer's partner (Dummy) lays their cards face-up. Declarer plays both hands.
- **Following Suit**: Players must follow the lead suit if possible. Highest trump wins; otherwise, the highest card of the lead suit wins.

### Phase 3: Scoring

Points are recorded in two categories:

- **Below the Line**: Points for tricks bid and made. The first side to reach **100 points** wins a game.
- **Above the Line**: Bonuses for overtricks, slams, rubber completion, and penalties for failed contracts (undertricks).

## Scoring Details

| Suit                               | Points per Trick (Above 6)    |
| :--------------------------------- | :---------------------------- |
| **Clubs** (♣️) / **Diamonds** (♦️) | 20 points                     |
| **Hearts** (♥️) / **Spades** (♠️)  | 30 points                     |
| **No Trump** (NT)                  | 40 for the 1st, 30 for others |

### Bonuses & Penalties

- **Rubber Bonus**: 700 points for winning 2-0; 500 points for winning 2-1.
- **Slams**: 500 for Small Slam (12 tricks), 1000 for Grand Slam (13 tricks). Increases when vulnerable.
- **Doubled/Redouble**: Multiplies trick values and increases overtrick bonuses and undertrick penalties significantly.

### Implementation Notes

- **Honors**: Bonuses for holding high cards (Honors) in a single hand are **not implemented** in this digital version.
- **Single Session**: This implementation tracks the full rubber until one side wins two games.

## Game Strategy

- **Bidding**: Aim for "Game" (3NT, 4♥️, 4♠️, or 5♣️/5♦️) to score 100 points below the line in one deal.
- **Defense**: When vulnerable, be cautious about overbidding, as the penalties for going "down" are much higher.
- **Declarer**: Use the dummy's strengths to "finesse" high cards from the opponents.

## Bidding Strategy and AI Tips

### High Card Points (HCP)

Use the standard scale to evaluate your hand strength:

- **Ace**: 4 points
- **King**: 3 points
- **Queen**: 2 points
- **Jack**: 1 point
- **Total**: 40 points in the deck.

### Opening the Bidding

- **Pass**: If you have fewer than 12 HCP, you should usually Pass unless you have a very long suit (6+ cards).
- **Opening at Level 1**: Open with 12–21 HCP. Prefer your longest suit (5+ cards).
- **1NT Opening**: Specifically used for balanced hands (no voids, no singletons) with **15–17 HCP**.

### Reaching Game and Slams

Collaborate with your partner to reach the optimal level based on your **combined HCP**:

- **Game (3NT, 4♥️, 4♠️)**: Requires approximately **25–26 combined HCP**.
- **Game (5♣️, 5♦️)**: Requires approximately **28–29 combined HCP**.
- **Small Slam (Level 6)**: Requires at least **33 combined HCP**. Do not bid level 6 unless you and your partner have nearly all top honors.
- **Grand Slam (Level 7)**: Requires at least **37 combined HCP**. This means you must hold almost every Ace and King in the deck. **Bidding 7NT is extremely rare** and should only be done if you are certain you can win all 13 tricks.

### Response Strategy

- **Support partner**: If your partner bids a suit and you have 3+ cards in it, "raise" that suit to the appropriate level based on your points.
- **New suit**: Bidding a new suit shows 6+ HCP and is "forcing" (partner should not pass).
- **No Trump response**: Shows a balanced hand and specific point ranges (6–9 for 1NT, 10–12 for 2NT).

### AI and Implementation Notes

- **Vulnerability**: Penalties for failing a contract are much higher when you are vulnerable. If you don't have the points for a high bid, **Pass** rather than risking a large penalty.
- **Overcalling**: Only bid over an opponent if you have a strong suit (5+ cards) and 10+ HCP.
- **Three Passes**: If the bidding starts with three passes, the hand is "passed out" and the deal ends with no score. Avoid passing with 12+ HCP to ensure your side has a chance to play.
