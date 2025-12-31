# Podkidnoy Durak Rules

Podkidnoy Durak (Подкидной Дурак) is a classic Russian card game for 2 players. This implementation follows the rules on [Pagat.com](https://www.pagat.com/beating/podkidnoy_durak.html).

The goal is to get rid of all your cards. The last player left with cards in their hand is the "Durak" (the fool).

## Setup

- **Deck**: 36 cards (ranks 6-7-8-9-10-J-Q-K-A).
- **Trump**: The bottom card of the deck is revealed at the start to determine the trump suit for the entire game.
- **Deal**: Each player is dealt 6 cards.
- **First Attacker**: The player who holds the lowest trump card in their hand starts the first bout.

## Turn Structure (The Bout)

The game consists of a series of "bouts." In each bout, one player is the **attacker** and the other is the **defender**.

### Phase 1: Attack

- The attacker plays any card from their hand to the table.
- Subsequent cards played in the same bout (by either player) must match the rank of at least one card already on the table.
- A maximum of 6 attacks can be made in a single bout, and the attacker cannot play more cards than the defender has in their hand.

### Phase 2: Defense

- The defender must beat each attack card by playing a higher card of the same suit or any trump card.
- If the attack card is a trump, the defender must play a higher trump.
- After defending a card, the turn passes back to the attacker to either play another attack card or end the bout.

### Phase 3: Ending a Bout

There are two ways a bout ends:

1.  **Done (Successful Defense)**: If the attacker cannot or chooses not to play more cards, they click **"Done"**. All cards on the table are moved to the **discard pile** and are out of play. The defender becomes the new attacker for the next bout.
2.  **Take (Failed Defense)**: If the defender cannot or chooses not to beat an attack card, they click **"Take"**. They must add all cards from the table to their hand. In this case, the defender's turn to attack is skipped, and the current attacker starts a new bout.

### Phase 4: Drawing

At the end of every bout, players draw cards from the deck to bring their hand size back up to 6. The attacker draws first, then the defender. This continues until the deck is empty.

## Winning and Losing

- The game continues until the deck is empty and at least one player has run out of cards.
- If you run out of cards while the other player still has some, you have finished and are safe.
- The last player left with cards is the **Durak**.

## Game Strategy

- **Save Trumps**: Try to save your trump cards for late in the game when the deck is empty.
- **Force a Take**: Sometimes it's better to play multiple cards of the same rank to force the defender to take a large number of cards.
- **Discarding High Cards**: If you are the attacker and the defender is likely to beat your card, attacking with high non-trump cards can be a way to "flush" them out of play.
