## Overview

Skruuvi is a four-player auction trick-taking game played with a standard 52-card deck. This implementation follows the rules from:

- https://www.pagat.com/auctionwhist/skruuvi.html
- https://web.archive.org/web/20200716095115/https://www.klubi.fi/site/assets/files/1157/handbook_skruuvi.pdf

Normal match play uses 24 deals with rotating partnerships. The game supports both main normal modes (Kitty and Kotka) and an optional Bolshevik session flow.

## Components and Terms

- **Dealer**: rotates clockwise after each completed deal.
- **Kitty**: a 4-card extra packet in Kitty deals.
- **Kotka**: no-kitty deal type.
- **Main players**: bidder and bidder's current partner.
- **Defenders**: the two opponents of the main side.
- **All-pass Misere**: special branch when everyone passes in first auction round.
- **Double / Redouble**: multiplier raises contract value to x2 / x3.

## Match Structure

- **Players**: 4 seats (N, E, S, W).
- **Normal match length**: 24 deals.
- **Deal pattern in each 8-deal block**:
  - Deals 1-4: Kitty
  - Deals 5-8: Kotka
- **Partnership rotation by 8-deal session**:
  - Deals 1-8: N/S vs E/W
  - Deals 9-16: N/E vs S/W
  - Deals 17-24: N/W vs E/S

## Setup and Dealing

- **Deck**: standard 52 cards, ranks 2..10, J, Q, K, A.
- **Kitty deal**: 12 cards to each player + 4-card kitty.
- **Kotka deal**: 13 cards to each player, no kitty.
- **Deterministic shuffle**: each deal is shuffled from game seed + deal number.

## Auction and Contract (Normal Play)

Auction proceeds clockwise from dealer.

### Bid Order

- **Kitty order**: misere < spades < clubs < diamonds < hearts < grand.
- **Kotka order**: spades < clubs < diamonds < hearts < misere < grand.
- Bids must strictly outrank previous bids.
- In Kotka, opening bid must be at least level 6.

### Auction Outcomes

- If all four first calls are pass, the game enters **All-pass Misere** branch.
- If a highest bid exists and then 8 consecutive passes occur, auction ends and bidder side moves to exchange/extended phases.

### Extended Bidding

After main-player exchange:

- Only the two main players act.
- Ends after 4 consecutive passes.
- Final contract minimum:
  - Kitty: level 5+
  - Kotka: level 6+

### Doubling Windows

- Defenders get double opportunities in order.
- If doubled, main players get redouble opportunities in order.
- Multiplier is x1, x2, or x3.

## Exchange Phases

### Kitty Branch

1. Bidder passes 4 cards to partner.
2. Partner distributes one card to each of the other three players.
3. Extended bidding begins.

### Kotka Branch

1. Bidder passes 4 cards to partner.
2. Partner passes 4 cards back to bidder.
3. Extended bidding begins.

### Defender Exchange (Kitty only)

If first bid level was below 6, defenders exchange one card with each other before doubling phase.

### All-pass Exchange

In all-pass branch, each player performs one mandatory partner exchange card in a fixed sequence.

## Play

- 13 tricks are played.
- Players must follow suit if possible.
- Trick winner:
  - Highest trump if contract has trump suit.
  - Otherwise highest card of lead suit.
- Trick winner leads next trick.

## Scoring

### Contract Values

For level 5/6/7 contracts:

- Made trumps/grand: 25 / 35 / 50
- Made misere: 10 / 20 / 35
- Overtricks: 2 at levels 5 and 6, none at 7
- First undertrick:
  - Trumps/grand: 5 / 10 / 15
  - Misere: 10 / 15 / 20
- Additional undertricks: 5 each

### Multipliers and Penalties

- Double = x2, redouble = x3.
- Misere and all-pass ace penalties are applied by trick number.
- Ace penalties are not multiplied.

### Side and Match Accounting

- Normal play deltas are applied to the current rotating partnership mapping.
- Match winner after deal 24 is highest individual total score.
- Equal top score is a tie.

## All-pass Misere Branch

- In Kitty deals, kitty cards are dealt one each to players.
- Mandatory partner exchange sequence occurs.
- All-pass doubling/redoubling window occurs.
- Then normal trick play starts with leader at dealer's left.

## Bolshevik Session

Bolshevik is supported as an optional separate session flow.

### Session Rules

- Up to 8 Bolshevik deals in a set.
- A player should not declare Bolshevik twice within same set.
- Auction round includes only players who have not yet declared in the set.

### Bolshevik Auction

- Eligible players act once in clockwise order starting from dealer.
- Each chooses pass or bolshevik.
- If one bidder remains, that player is declarer.
- If several bid, bidders resolve in bid order:
  - bolshevik = keep declaration
  - pass = withdraw
- If all pass on a non-forced deal, deal is annulled and dealer rotates.
- **Forced rule**: when remaining deals equal remaining undeclared players, last eligible player cannot pass if no bid exists.

### Bolshevik Deal Flow

- Declarer takes revealed kitty (4 cards).
- Declarer returns one card to each defender.
- Declarer chooses contract: 7 misere or 7-level suit/grand.
- Defender doubling and declarer redoubling follow.
- Opening lead is by declarer's right-hand opponent.

### Bolshevik Scoring

- Declarer scores against three defenders individually.
- Defenders split opposite value equally.
- Set keeps raw totals; when set closes, totals are normalized by dividing by 3 before adding to match totals.

## Deterministic Convention Enforcement

This implementation enforces strict deterministic signaling/infraction rules:

- 4-card exchange packets (Kitty and Kotka) must be either:
  - one suit (4), or
  - a 3+1 (or 1+3) suit split in sending order,
    with descending rank order inside each suit run.
- Partner suit signaling is recorded from defender and all-pass exchanges.
- In non-Bolshevik play, if opener's partner doubled and opener has recorded signal suit, opening another suit triggers deterministic penalty.
- Infractions are scored as fixed point penalties (`-5`) to offending seat.

## Game Strategy

- In Kitty and Kotka, protect information in 4-card exchanges by keeping suit-grouped packets and clean high-to-low order.
- In auctions, treat Kotka openings carefully because the level-6 floor raises risk quickly if your hand is thin.
- In extended bidding, coordinate with partner around fit and control cards; avoid overbidding marginal hands into doubled penalties.
- In misere contracts, track aces aggressively because ace penalties scale by trick number and can swing the deal.
- In all-pass branch, use the mandatory exchange to shape safe exits and reduce forced trick wins later.
- In defender doubling decisions, focus on whether declarer likely misses target by at least one trick, not just on raw high-card count.
- In Bolshevik, conserve your one declaration per session and avoid early commitment unless the kitty upside is strong.
- Across 24 deals, manage variance by avoiding high-multiplier contracts without clear trick path, since rotating partnerships amplify swings.
