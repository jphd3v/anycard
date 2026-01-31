## Overview

Six-Card Cribbage for 2 players using a standard 52-card deck, based on [rules on Pagat.com](https://www.pagat.com/adders/crib6.html). Players score points during the play phase by forming combinations (pairs, runs, fifteens, and thirty-ones), and during the show phase by counting combinations in their hands. The dealer receives an extra hand called the crib. The game is a race to 121 points.

## Setup

- **Deck**: Standard 52-card deck.
- **Players**: 2 players.
- **Dealing**: 6 cards are dealt to each player. The dealer alternates each hand.
- **The Crib**: After dealing, each player discards 2 cards face-down to form the crib, a special hand that belongs to the dealer and is scored after both players' hands.

## Card Values

Cards have the following values for counting toward combinations:

| Card                  | Value      |
| :-------------------- | :--------- |
| **Ace**               | 1          |
| **2 - 10**            | Face value |
| **Jack, Queen, King** | 10 each    |

## Turn Structure

Each hand consists of three distinct phases: **Discard**, **Play**, and **Show**.

### 1. Discard Phase

Each player selects **2 cards** from their hand and discards them face-down to form **the crib**. The crib belongs to the dealer and will be scored after both players' hands during the show phase.

### 2. Starter Card

After both players have discarded, the non-dealer cuts the deck. The top card of the lower portion is turned face-up as the **starter card**.

- **His Heels**: If the starter is a Jack, the dealer immediately scores **2 points**.

### 3. Play Phase

Players alternate playing one card at a time from their hand, face-up to the play pile. A running count is maintained of all cards played.

**Play Rules:**

- The count starts at 0.
- Cards are added to the running count at their face value (Ace=1, 2-10=value, J/Q/K=10).
- The running count **cannot exceed 31**.
- If a player cannot play without exceeding 31, they must select the **"Go"** action to pass the turn.
- When both players cannot play (or the count reaches exactly 31), the count resets to 0 and play continues.
- Play ends when all 8 cards (4 per player) have been played.

**Scoring During Play:**

Points are awarded immediately when the following combinations are formed:

- **Fifteen (15)**: Making the count exactly 15 scores **2 points**.
- **Pair**: Playing a card of the same rank as the immediately preceding card scores **2 points**.
- **Pair Royal**: Three consecutive cards of the same rank score **6 points** (three pairs).
- **Double Pair Royal**: Four consecutive cards of the same rank score **12 points** (six pairs).
- **Run**: Three or more consecutive cards in sequence (regardless of suit) score points equal to the length of the run. The run must include the most recently played card.
- **Thirty-One (31)**: Making the count exactly 31 scores **2 points**.
- **Go**: When the opponent cannot play, the player who played last scores **1 point**.
- **Last Card**: If all cards are played and the count is under 31, the player of the last card scores **1 point**.

### 4. Show Phase

After the play phase, players score their hands using the **4 cards in hand plus the starter card** (5 cards total).

**Scoring Order:**

1. **Non-dealer's hand** is scored first.
2. **Dealer's hand** is scored second.
3. **Dealer's crib** is scored last.

The game checks for a winner after each hand/crib is scored.

**Scoring Combinations:**

All combinations within the 5 cards are counted:

- **Fifteen**: Every distinct combination of cards totaling 15 scores **2 points**.
- **Pair**: Every pair of cards with the same rank scores **2 points**.
  - Three of the same rank = **6 points** (three distinct pairs).
  - Four of the same rank = **12 points** (six distinct pairs).
- **Run**: A sequence of 3 or more cards scores points equal to the length of the run.
  - Duplicate ranks create multiple runs (e.g., 3-3-4-5 = two runs of 4 = **8 points**).
- **Flush**:
  - **In hand**: 4 cards of the same suit score **4 points**; all 5 including starter score **5 points**.
  - **In crib**: Flush only counts if all 5 cards (4 crib cards + starter) are the same suit (**5 points**).
- **His Nob**: Holding the Jack of the same suit as the starter scores **1 point**.

## Winning

The game ends immediately when a player reaches **121 points**. Scoring is checked after:

- His Heels (when starter is a Jack).
- Each scoring event during the play phase.
- Each hand and the crib during the show phase.

If both players reach 121 during the same show phase, the player with the higher score wins. If tied, play continues with another hand.

## Game Strategy

- **Discard Strategy**: When discarding to the crib, consider whether you are the dealer. As dealer, discard cards that work well together (like 5s, which combine with many cards to make 15). As non-dealer, discard cards that are less likely to score together.
- **Avoid Dangerous Counts**: During play, avoid making the count 5, 10, or 21, as these make it easy for the opponent to score a fifteen by playing a face card or a 5.
- **Lead Strategy**: Leading with a 4 is often safe, as the opponent cannot immediately make 15 (would need an Ace, but then you can pair it). Leading with a face card is risky, as a 5 scores an immediate 15.
- **Maximize Hand Value**: When choosing which cards to keep, look for cards that contribute to multiple combinations. A hand like 6-7-7-8 scores well (pairs, runs, and fifteens).
- **The Power of Fives**: A 5 is the most versatile card for scoring fifteens, as it combines with all face cards and tens. Hold onto 5s when possible.
- **Crib Awareness**: Remember that the dealer gets the crib. If you are the dealer and ahead in score, you can afford to be more conservative with your hand and load the crib with potential. If behind, you may need to keep your strongest cards in hand.
- **Count Management**: Keep track of which cards have been played during the play phase. This helps predict what combinations are still possible and whether your opponent can make a fifteen or run.
