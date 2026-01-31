# Joker

A trick-taking game for 4 players where you must bid exactly how many tricks you'll win.

## Overview

Joker is played over 24 hands across 4 sets. The unique feature is that players must bid exactly how many tricks they'll win, with a special dealer restriction ensuring at least one player will fail each hand.

Reference rules: [Pagat.com](https://www.pagat.com/exact/joker.html)

## Cards

36 cards total:

- Standard cards: A-K-Q-J-10-9-8-7-6 in each suit, **except** the 6♣ and 6♠
  are replaced by Jokers (so there are no black 6s).
- 2 Jokers (replacing the two black 6s)

Cards rank A (high) to 6 (low) within each suit.

## Game Structure

- **Set 1 (8 hands):** 1, 2, 3, 4, 5, 6, 7, 8 cards dealt
- **Set 2 (4 hands):** 9 cards each hand
- **Set 3 (8 hands):** 8, 7, 6, 5, 4, 3, 2, 1 cards dealt
- **Set 4 (4 hands):** 9 cards each hand

## Dealing and Trump

Cards are dealt one at a time to each player. The top card of the remaining deck is turned face-up to determine trump.
In 9-card hands (when all cards are dealt), the dealer's **last card** is turned face-up to determine trump:

- If the trump card is a Joker: **No Trump** for that hand
- Otherwise: the suit of the trump card is trump

## Bidding

Starting with the player left of the dealer, each player bids how many tricks they expect to win (0 to the number of cards dealt). Bidding 0 is called "passing."

**Dealer Restriction:** The total of all bids must NOT equal the number of cards dealt. This ensures at least one player will fail. The dealer, who bids last, must choose a bid that doesn't make the total equal the cards dealt.

Example: With 2 cards dealt, if the first three players bid 0, 0, 1, the dealer cannot bid 1 (total would be 2). They must bid 0 or 2.

## Playing

The player left of the dealer leads the first trick. Players must follow suit if able. If unable to follow suit, they must play trump if they have it. If they have neither, they may play any card.

**Jokers:**

- Jokers can be played to any trick
- When playing a Joker, you must announce it as **high** or **low**
- If a Joker is **led**, the player must also **announce a suit** to be followed (for both high and low)

**High Joker:**

- When led as high, you must announce a suit. Each other player must play their **highest card** of that suit (or the other Joker)
- A high Joker wins the trick EXCEPT:
  - If another high Joker is played after it (the second high Joker wins)
  - If the high Joker was led as a non-trump suit and a player plays trump (highest trump wins)

**Low Joker:**

- Acts as the lowest card in the deck
- When led, the announced suit becomes the suit to be followed
- The low Joker loses to any card of the announced suit, any trump, or a high Joker
- The low Joker **wins** only if no one follows the announced suit, no trump is played, and no high Joker is played

The highest trump wins the trick. If no trump was played, the highest card of the suit led wins.

## Scoring

**Made Bid Exactly:**

- Bid 0 (Pass) and won 0: **50 points**
- Bid all tricks and won all: **100 points per trick**
- Any other exact bid: **50 points per trick + 50 bonus**

**Failed Bid:**

- **10 points per trick won** (regardless of bid)

**Set Bonus:**
If you make your bid on every hand in a set, you earn a bonus equal to the highest score you earned on any single hand in that set.

## Winning

After 24 hands (4 sets), the player with the most points wins!

## Game Strategy

- Treat bids as risk management: a small missed bid is worse than a safe zero.
- Track who is short in each suit to decide when to lead high Jokers.
- Use low Jokers to force a suit when you expect others are void.
- When you have trump control, push tricks late to protect exact bids.
- In 9-card hands, count cards tightly; there is no draw pile.
