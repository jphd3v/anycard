/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import type { GamePlugin, GameRuleModule } from "../interface.js";
import type { ValidationState } from "../../validation-state.js";
import type {
  Card,
  ClientIntent,
  ActionCell,
  Scoreboard,
  ScoreboardCell,
} from "../../../../shared/schemas.js";
import type {
  EngineEvent,
  ValidationResult,
} from "../../../../shared/validation.js";
import {
  distributeRoundRobin,
  gatherAllCards,
  shuffleAllCards,
} from "../util/dealing.js";
import { projectPilesAfterEvents } from "../util/piles.js";

const SUITS = ["clubs", "diamonds", "hearts", "spades"] as const;

/**
 * Joker - A trick-taking game for 4 players
 *
 * Key features:
 * - 36 cards: standard deck minus red 6s, with 2 Jokers replacing black 6s
 * - 24 hands across 4 sets
 * - Bidding with dealer restriction (total bids ≠ cards dealt)
 * - Jokers can be played as high or low
 * - When high Joker is led, others must play highest card of suit
 * - Exact bid scoring: 50 per trick + 50 bonus (or 100 per trick if bid all)
 */

interface JokerRulesState {
  phase:
    | "initial"
    | "dealing"
    | "bidding"
    | "playing"
    | "joker-selection"
    | "hand-ended"
    | "set-ended"
    | "game-ended";

  // Game structure
  hasDealt: boolean; // tracks if cards have been dealt (used by UI to hide start overlay)
  currentSet: number; // 1-4
  currentHandInSet: number; // varies by set
  cardsThisHand: number; // number of cards dealt this hand
  dealerSeat: number; // 0-3

  // Bidding
  bids: Array<{ player: string; bid: number }>; // bids for current hand

  // Joker selection
  pendingJokerCardId: number | null; // Card ID of Joker being played

  // Trick-taking
  currentTrick: Array<{
    player: string;
    cardId: number;
    suit: string;
    rank: string;
    isJoker: boolean;
    jokerMode?: "high" | "low";
    jokerSuit?: string; // suit announced for Joker
  }>;
  leadSuit: string | null;
  trumpSuit: string | null; // determined by face-up card after deal
  tricksWon: Record<string, number>; // player -> tricks won this hand

  // Scoring
  handScores: Record<string, number>; // player -> score this hand
  setScores: Record<string, number>; // player -> total score this set
  gameScores: Record<string, number>; // player -> total game score
  setSuccesses: Record<string, number[]>; // player -> array of hand scores they succeeded on in current set

  // AI context
  recap: string[];
}

// Set structure: [set1, set2, set3, set4]
// Set 1: 1,2,3,4,5,6,7,8 cards
// Set 2 & 4: 9,9,9,9 cards
// Set 3: 8,7,6,5,4,3,2,1 cards
const SET_STRUCTURES = [
  [1, 2, 3, 4, 5, 6, 7, 8], // Set 1
  [9, 9, 9, 9], // Set 2
  [8, 7, 6, 5, 4, 3, 2, 1], // Set 3
  [9, 9, 9, 9], // Set 4
];

type ScoreboardPlayer = { id: string; name: string };

function buildScoreboard(
  players: ScoreboardPlayer[],
  rs: JokerRulesState,
  title?: string
): Scoreboard {
  const scoreboardCells: ScoreboardCell[] = [
    { row: 0, col: 0, text: "Player", role: "header", align: "left" },
    { row: 0, col: 1, text: "Bid", role: "header", align: "right" },
    { row: 0, col: 2, text: "Won", role: "header", align: "right" },
    { row: 0, col: 3, text: "Score", role: "header", align: "right" },
    { row: 0, col: 4, text: "Total", role: "header", align: "right" },
  ];

  players.forEach((p, idx) => {
    const row = idx + 1;
    const bid = rs.bids.find((b) => b.player === p.id)?.bid ?? 0;
    const won = rs.tricksWon[p.id] ?? 0;
    const score = rs.handScores[p.id] ?? 0;
    const total = rs.gameScores[p.id] ?? 0;

    scoreboardCells.push(
      { row, col: 0, text: p.name, role: "body", align: "left" },
      { row, col: 1, text: `${bid}`, align: "right" },
      { row, col: 2, text: `${won}`, align: "right" },
      { row, col: 3, text: `${score}`, align: "right" },
      { row, col: 4, text: `${total}`, align: "right" }
    );
  });

  return {
    id: "scores",
    title: title ?? "Scores",
    rows: players.length + 1,
    cols: 5,
    cells: scoreboardCells,
  };
}

function getCardsForHand(set: number, handInSet: number): number {
  return SET_STRUCTURES[set - 1][handInSet - 1];
}

function getTotalHandsInSet(set: number): number {
  return SET_STRUCTURES[set - 1].length;
}

function rankValue(rank: string): number {
  const order = ["A", "K", "Q", "J", "10", "9", "8", "7", "6"];
  return order.indexOf(rank);
}

function determineTrickWinner(
  trick: JokerRulesState["currentTrick"],
  trumpSuit: string | null,
  leadSuit: string | null
): string {
  if (trick.length === 0) throw new Error("Empty trick");

  const leadCard = trick[0];

  const leadIsHighJoker = leadCard.isJoker && leadCard.jokerMode === "high";

  // High Joker led as non-trump suit can be beaten by trump
  if (
    leadIsHighJoker &&
    leadCard.jokerSuit &&
    leadCard.jokerSuit !== trumpSuit &&
    trumpSuit
  ) {
    const trumpCards = trick.filter((c) => !c.isJoker && c.suit === trumpSuit);
    if (trumpCards.length > 0) {
      // Highest trump wins
      trumpCards.sort((a, b) => rankValue(a.rank) - rankValue(b.rank));
      return trumpCards[0].player;
    }
  }

  // Check for high Jokers
  const highJokers = trick.filter((c) => c.isJoker && c.jokerMode === "high");

  if (highJokers.length > 0) {
    // If multiple high Jokers, the last one wins
    if (highJokers.length > 1) {
      return highJokers[highJokers.length - 1].player;
    }

    // Otherwise high Joker wins
    return highJokers[0].player;
  }

  // No high Jokers: normal trick-taking rules
  // First check for trump cards
  if (trumpSuit) {
    const trumpCards = trick.filter((c) => !c.isJoker && c.suit === trumpSuit);
    if (trumpCards.length > 0) {
      trumpCards.sort((a, b) => rankValue(a.rank) - rankValue(b.rank));
      return trumpCards[0].player;
    }
  }

  // No trumps: highest card of lead suit wins
  const leadSuitCards = leadSuit
    ? trick.filter((c) => !c.isJoker && c.suit === leadSuit)
    : [];
  if (leadSuitCards.length > 0) {
    leadSuitCards.sort((a, b) => rankValue(a.rank) - rankValue(b.rank));
    return leadSuitCards[0].player;
  }

  // Low Joker wins only if nothing followed suit or trumped
  if (leadCard.isJoker && leadCard.jokerMode === "low") {
    return leadCard.player;
  }

  // Fallback: lead card wins (should not happen in normal play)
  return leadCard.player;
}

function buildDealEvents(
  state: ValidationState,
  rs: JokerRulesState
): EngineEvent[] {
  const events: EngineEvent[] = [];
  const cardsPerPlayer = rs.cardsThisHand;
  const dealer = state.players[rs.dealerSeat];

  // Gather and shuffle
  events.push(...gatherAllCards(state));
  const shuffled = shuffleAllCards(
    state,
    rs.currentSet * 100 + rs.currentHandInSet,
    `${dealer.id}-${rs.currentSet}-${rs.currentHandInSet}`
  );

  // Deal cards to players, starting from left of dealer
  const handPiles = [];
  for (let i = 0; i < 4; i++) {
    const playerIdx = (rs.dealerSeat + 1 + i) % 4;
    handPiles.push(`hand-${state.players[playerIdx].id}`);
  }

  const { events: dealEvents, nextIndex } = distributeRoundRobin(
    shuffled,
    handPiles,
    cardsPerPlayer
  );
  events.push(...dealEvents);

  // Determine trump by flipping a card (if cards > 0)
  let trumpSuit: string | null = null;
  let trumpCard: Card | null = null;

  if (cardsPerPlayer > 0) {
    let trumpCardId: number | undefined;

    if (cardsPerPlayer === 9) {
      // For 9-card hands, trump is dealer's last card
      const afterDeal = projectPilesAfterEvents(state, events);
      const dealerHand = afterDeal[`hand-${dealer.id}`];
      if (dealerHand?.cardIds && dealerHand.cardIds.length > 0) {
        trumpCardId = dealerHand.cardIds[dealerHand.cardIds.length - 1];
      }
    } else {
      // For non-9-card hands, trump is the next card from the shuffled deck
      if (nextIndex < shuffled.length) {
        trumpCardId = shuffled[nextIndex];
      }
    }

    if (trumpCardId !== undefined) {
      trumpCard =
        Object.values(state.allCards).find((c) => c.id === trumpCardId) || null;
    }

    if (trumpCard) {
      if (trumpCard.rank === "Joker") {
        trumpSuit = null; // No trump
        events.push({
          type: "announce",
          text: "Trump card is Joker - No Trump this hand!",
        });
      } else {
        trumpSuit = trumpCard.suit;
        events.push({
          type: "announce",
          text: `Trump suit: ${trumpSuit} (${trumpCard.rank})`,
        });
      }
    }
  }

  // Initialize tricks won
  const tricksWon: Record<string, number> = {};
  state.players.forEach((p) => {
    tricksWon[p.id] = 0;
  });

  const nextRulesState: JokerRulesState = {
    ...rs,
    phase: "bidding",
    hasDealt: true,
    trumpSuit,
    tricksWon,
    bids: [],
    recap: [
      ...rs.recap,
      `Dealt ${cardsPerPlayer} cards. Trump: ${trumpSuit || "None"}`,
    ],
  };

  events.push({
    type: "set-rules-state",
    rulesState: nextRulesState,
  });

  // First bidder is left of dealer
  const firstBidder = state.players[(rs.dealerSeat + 1) % 4];
  events.push({
    type: "set-current-player",
    player: firstBidder.id,
  });

  // Set up bid actions
  const bidCells: ActionCell[] = [];
  for (let i = 0; i <= cardsPerPlayer; i++) {
    bidCells.push({
      id: `bid-${i}`,
      label: i === 0 ? "Pass (0)" : `${i}`,
      enabled: true,
      row: 0,
      col: i,
    });
  }

  events.push({
    type: "set-actions",
    actions: {
      rows: 1,
      cols: cardsPerPlayer + 1,
      cells: bidCells,
    },
  });

  events.push({
    type: "set-scoreboards",
    scoreboards: [buildScoreboard(state.players, nextRulesState)],
  });

  return events;
}

function isValidPlay(
  card: Card,
  hand: Card[],
  leadSuit: string | null,
  trumpSuit: string | null,
  leadCardIsHighJoker: boolean,
  highJokerSuit: string | null
): { valid: boolean; reason?: string } {
  const isJoker = card.rank === "Joker";

  // Jokers can always be played
  if (isJoker) {
    return { valid: true };
  }

  // Leading: any card is valid
  if (!leadSuit) {
    return { valid: true };
  }

  // Following when high Joker was led
  if (leadCardIsHighJoker && highJokerSuit) {
    // Must play highest card of specified suit if you have it
    const cardsOfSuit = hand.filter(
      (c) => c.suit === highJokerSuit && c.rank !== "Joker"
    );
    if (cardsOfSuit.length > 0) {
      // Find highest card of suit
      const highest = cardsOfSuit.reduce((h, c) =>
        rankValue(c.rank) < rankValue(h.rank) ? c : h
      );
      if (card.id !== highest.id) {
        return {
          valid: false,
          reason: `Must play highest ${highJokerSuit}: ${highest.rank}`,
        };
      }
    }
    // If no cards of suit, normal follow/trump rules apply
    // Fall through to normal logic
  }

  // Normal follow suit rules
  const hasLeadSuit = hand.some(
    (c) => c.suit === leadSuit && c.rank !== "Joker"
  );
  if (hasLeadSuit) {
    if (card.suit !== leadSuit) {
      return { valid: false, reason: `Must follow suit: ${leadSuit}` };
    }
    return { valid: true };
  }

  // No lead suit: must trump if able
  if (trumpSuit) {
    const hasTrump = hand.some(
      (c) => c.suit === trumpSuit && c.rank !== "Joker"
    );
    if (hasTrump && card.suit !== trumpSuit) {
      return { valid: false, reason: `Must play trump: ${trumpSuit}` };
    }
  }

  // No lead suit, no trump (or already playing trump): any card is valid
  return { valid: true };
}

const validate: GameRuleModule["validate"] = (
  state: ValidationState,
  intent: ClientIntent
): ValidationResult => {
  const rs = state.rulesState as JokerRulesState;
  const events: EngineEvent[] = [];

  // ===== INITIAL SETUP =====
  if (rs.phase === "initial") {
    if (intent.type !== "action" || intent.action !== "start-game") {
      return {
        valid: false,
        reason:
          "The game has not been started yet. Use the 'Start Game' action.",
        engineEvents: [],
      };
    }

    // Initialize scores
    const gameScores: Record<string, number> = {};
    const setScores: Record<string, number> = {};
    const setSuccesses: Record<string, number[]> = {};
    state.players.forEach((p) => {
      gameScores[p.id] = 0;
      setScores[p.id] = 0;
      setSuccesses[p.id] = [];
    });

    const nextRulesState: JokerRulesState = {
      ...rs,
      phase: "dealing",
      currentSet: 1,
      currentHandInSet: 1,
      cardsThisHand: 1,
      dealerSeat: 0,
      bids: [],
      currentTrick: [],
      leadSuit: null,
      trumpSuit: null,
      tricksWon: {},
      handScores: {},
      setScores,
      gameScores,
      setSuccesses,
      recap: ["Game started! Set 1, Hand 1: 1 card each"],
    };

    events.push(...buildDealEvents(state, nextRulesState));

    return { valid: true, engineEvents: events };
  }

  // ===== DEALING =====
  if (rs.phase === "dealing") {
    if (
      intent.type === "action" &&
      (intent.action === "start-game" || intent.action === "deal")
    ) {
      events.push(...buildDealEvents(state, rs));
      return { valid: true, engineEvents: events };
    }
  }

  // ===== BIDDING =====
  if (rs.phase === "bidding") {
    if (intent.type === "action" && intent.action.startsWith("bid-")) {
      const bidValue = parseInt(intent.action.substring(4));
      const player = state.players.find((p) => p.id === intent.playerId);
      if (!player) {
        return { valid: false, reason: "Player not found", engineEvents: [] };
      }

      // Check if it's player's turn
      if (intent.playerId !== state.currentPlayer) {
        return {
          valid: false,
          reason: "Not your turn to bid",
          engineEvents: [],
        };
      }

      // Dealer restriction: total bids cannot equal cards dealt
      const isDealer = state.players.indexOf(player) === rs.dealerSeat;
      if (isDealer) {
        const totalSoFar = rs.bids.reduce((sum, b) => sum + b.bid, 0);
        if (totalSoFar + bidValue === rs.cardsThisHand) {
          return {
            valid: false,
            reason: `Dealer cannot bid ${bidValue} (total would equal ${rs.cardsThisHand})`,
            engineEvents: [],
          };
        }
      }

      const newBids = [...rs.bids, { player: intent.playerId, bid: bidValue }];

      events.push({
        type: "announce",
        text: `${player.name} bids ${bidValue === 0 ? "Pass (0)" : bidValue}`,
      });

      // Check if bidding is complete
      if (newBids.length === 4) {
        const bidSummary = `Bids: ${newBids
          .map(
            (b) =>
              `${state.players.find((p) => p.id === b.player)?.name}=${b.bid}`
          )
          .join(", ")}`;

        // Bidding complete, start playing
        const tricksWon: Record<string, number> = {};
        state.players.forEach((p) => {
          tricksWon[p.id] = 0;
        });

        events.push({
          type: "announce",
          text: bidSummary,
        });

        events.push({
          type: "set-rules-state",
          rulesState: {
            ...rs,
            phase: "playing",
            bids: newBids,
            currentTrick: [],
            leadSuit: null,
            tricksWon,
            recap: [...rs.recap, bidSummary],
          },
        });

        // First player (left of dealer) leads
        const firstPlayer = state.players[(rs.dealerSeat + 1) % 4];
        events.push({
          type: "set-current-player",
          player: firstPlayer.id,
        });

        events.push({
          type: "set-actions",
          actions: { rows: 0, cols: 0, cells: [] },
        });

        return { valid: true, engineEvents: events };
      } else {
        // Next player bids
        const nextPlayerIndex = (rs.dealerSeat + 1 + newBids.length) % 4;
        const nextPlayer = state.players[nextPlayerIndex];

        events.push({
          type: "set-rules-state",
          rulesState: {
            ...rs,
            bids: newBids,
          },
        });

        events.push({
          type: "set-current-player",
          player: nextPlayer.id,
        });

        return { valid: true, engineEvents: events };
      }
    }
  }

  // ===== PLAYING =====
  if (rs.phase === "playing") {
    if (intent.type === "move") {
      if (intent.playerId !== state.currentPlayer) {
        return { valid: false, reason: "Not your turn", engineEvents: [] };
      }

      const card = Object.values(state.allCards).find(
        (c) => c.id === intent.cardId
      );
      if (!card) {
        return { valid: false, reason: "Card not found", engineEvents: [] };
      }

      // Get player's hand
      const handPile = state.piles[`hand-${intent.playerId}`];
      if (
        !handPile ||
        !handPile.cards ||
        !handPile.cards.some((c) => c.id === card.id)
      ) {
        return { valid: false, reason: "Card not in hand", engineEvents: [] };
      }

      const hand = handPile.cards as Card[];

      const isJoker = card.rank === "Joker";

      // If playing a Joker, transition to joker-selection phase
      if (isJoker) {
        const isLeading = rs.currentTrick.length === 0;

        // Build action buttons for Joker selection
        const actionCells: ActionCell[] = [];
        let col = 0;

        if (isLeading) {
          // When leading, Joker play must include a suit for both high and low
          for (const suit of SUITS) {
            actionCells.push({
              id: `joker-high-${suit}`,
              label: `High ${suit === "hearts" ? "♥" : suit === "diamonds" ? "♦" : suit === "clubs" ? "♣" : "♠"}`,
              enabled: true,
              row: 0,
              col: col++,
            });
          }
          for (const suit of SUITS) {
            actionCells.push({
              id: `joker-low-${suit}`,
              label: `Low ${suit === "hearts" ? "♥" : suit === "diamonds" ? "♦" : suit === "clubs" ? "♣" : "♠"}`,
              enabled: true,
              row: 0,
              col: col++,
            });
          }
        } else {
          // When following, high Joker doesn't need a suit
          actionCells.push({
            id: "joker-high",
            label: "Play as High",
            enabled: true,
            row: 0,
            col: col++,
          });

          // Low joker option always available
          actionCells.push({
            id: "joker-low",
            label: "Play as Low",
            enabled: true,
            row: 0,
            col: col++,
          });
        }

        events.push({
          type: "set-rules-state",
          rulesState: {
            ...rs,
            phase: "joker-selection",
            pendingJokerCardId: card.id,
          },
        });

        events.push({
          type: "set-actions",
          actions: {
            rows: 1,
            cols: col,
            cells: actionCells,
          },
        });

        events.push({
          type: "announce",
          text: `Select how to play Joker`,
        });

        return { valid: true, engineEvents: events };
      }

      // Non-Joker card - play normally
      let jokerMode: "high" | "low" | undefined;
      let jokerSuit: string | undefined;

      // Validate play
      const leadCardIsHighJoker =
        rs.currentTrick.length > 0 &&
        rs.currentTrick[0].isJoker &&
        rs.currentTrick[0].jokerMode === "high";

      const highJokerSuit = leadCardIsHighJoker
        ? rs.currentTrick[0].jokerSuit || null
        : null;

      const playValidation = isValidPlay(
        card,
        hand,
        rs.leadSuit,
        rs.trumpSuit,
        leadCardIsHighJoker,
        highJokerSuit
      );

      if (!playValidation.valid) {
        return {
          valid: false,
          reason: playValidation.reason,
          engineEvents: [],
        };
      }

      // Play the card
      events.push({
        type: "move-cards",
        cardIds: [card.id],
        fromPileId: `hand-${intent.playerId}`,
        toPileId: "trick",
      });

      const newTrick = [
        ...rs.currentTrick,
        {
          player: intent.playerId,
          cardId: card.id,
          suit: card.suit,
          rank: card.rank,
          isJoker,
          jokerMode,
          jokerSuit,
        },
      ];

      // Set lead suit if this is the first card
      let newLeadSuit = rs.leadSuit;
      if (rs.currentTrick.length === 0) {
        if (isJoker && jokerMode === "high") {
          newLeadSuit = jokerSuit || null;
        } else if (isJoker && jokerMode === "low") {
          newLeadSuit = null; // low joker doesn't set lead suit
        } else {
          newLeadSuit = card.suit;
        }
      }

      const player = state.players.find((p) => p.id === intent.playerId);
      const jokerDesc = isJoker
        ? ` as ${jokerMode}${jokerMode === "high" && jokerSuit ? ` ${jokerSuit}` : ""}`
        : "";

      events.push({
        type: "announce",
        text: `${player?.name} plays ${card.rank + " " + card.suit}${jokerDesc}`,
      });

      // Check if trick is complete
      if (newTrick.length === 4) {
        // Determine winner
        const winner = determineTrickWinner(
          newTrick,
          rs.trumpSuit,
          newLeadSuit
        );
        const winnerName = state.players.find((p) => p.id === winner)?.name;

        events.push({
          type: "announce",
          text: `${winnerName} wins the trick`,
        });

        // Move cards to winner's tricks pile
        const trickCardIds = newTrick.map((c) => c.cardId) as [
          number,
          ...number[],
        ];
        events.push({
          type: "move-cards",
          cardIds: trickCardIds,
          fromPileId: "trick",
          toPileId: `tricks-${winner}`,
        });

        const newTricksWon = { ...rs.tricksWon };
        newTricksWon[winner] = (newTricksWon[winner] || 0) + 1;

        // Check if hand is complete
        const totalTricks = Object.values(newTricksWon).reduce(
          (a, b) => a + b,
          0
        );
        if (totalTricks === rs.cardsThisHand) {
          // Hand complete - calculate scores
          const handScores: Record<string, number> = {};
          const newSetSuccesses = { ...rs.setSuccesses };

          for (const player of state.players) {
            const bid = rs.bids.find((b) => b.player === player.id)?.bid || 0;
            const won = newTricksWon[player.id] || 0;
            let score = 0;

            if (bid === won) {
              // Made the bid exactly
              if (bid === 0) {
                // Pass and made it
                score = 50;
              } else if (bid === rs.cardsThisHand) {
                // Bid all tricks and made it
                score = 100 * bid;
              } else {
                // Normal successful bid
                score = 50 * bid + 50;
              }

              // Track success for set bonus
              if (!newSetSuccesses[player.id]) {
                newSetSuccesses[player.id] = [];
              }
              newSetSuccesses[player.id].push(score);
            } else {
              // Failed bid
              score = 10 * won;
            }

            handScores[player.id] = score;
          }

          // Update set and game scores
          const newSetScores = { ...rs.setScores };
          const newGameScores = { ...rs.gameScores };
          for (const player of state.players) {
            newSetScores[player.id] += handScores[player.id];
            newGameScores[player.id] += handScores[player.id];
          }

          const scoreRecap = state.players
            .map((p) => {
              const bid = rs.bids.find((b) => b.player === p.id)?.bid || 0;
              const won = newTricksWon[p.id] || 0;
              const made = bid === won ? "✓" : "✗";
              return `${p.name}: ${bid}/${won} ${made} +${handScores[p.id]}`;
            })
            .join(", ");

          const handEndedState: JokerRulesState = {
            ...rs,
            phase: "hand-ended",
            currentTrick: [],
            leadSuit: null,
            tricksWon: newTricksWon,
            handScores,
            setScores: newSetScores,
            gameScores: newGameScores,
            setSuccesses: newSetSuccesses,
            pendingJokerCardId: null,
            recap: [
              ...rs.recap,
              `Hand ${rs.currentHandInSet} ended: ${scoreRecap}`,
            ],
          };

          events.push({
            type: "set-rules-state",
            rulesState: handEndedState,
          });

          const nextDealerSeat = (rs.dealerSeat + 1) % 4;
          const nextDealer = state.players[nextDealerSeat];

          events.push({
            type: "set-current-player",
            player: nextDealer?.id ?? null,
          });

          events.push({
            type: "set-scoreboards",
            scoreboards: [
              buildScoreboard(
                state.players,
                handEndedState,
                `Hand ${rs.currentHandInSet} Complete`
              ),
            ],
          });

          events.push({
            type: "set-actions",
            actions: {
              rows: 1,
              cols: 1,
              cells: [
                {
                  id: "next-hand",
                  label: "Next Hand",
                  enabled: true,
                  row: 0,
                  col: 0,
                },
              ],
            },
          });

          return { valid: true, engineEvents: events };
        } else {
          // Trick complete, winner leads next trick
          events.push({
            type: "set-rules-state",
            rulesState: {
              ...rs,
              currentTrick: [],
              leadSuit: null,
              tricksWon: newTricksWon,
              recap: [...rs.recap, `Trick ${totalTricks}: ${winnerName} wins`],
            },
          });

          events.push({
            type: "set-current-player",
            player: winner,
          });

          return { valid: true, engineEvents: events };
        }
      } else {
        // Trick continues
        const nextPlayerIndex =
          (state.players.findIndex((p) => p.id === intent.playerId) + 1) % 4;
        const nextPlayer = state.players[nextPlayerIndex];

        events.push({
          type: "set-rules-state",
          rulesState: {
            ...rs,
            currentTrick: newTrick,
            leadSuit: newLeadSuit,
          },
        });

        events.push({
          type: "set-current-player",
          player: nextPlayer.id,
        });

        return { valid: true, engineEvents: events };
      }
    }
  }

  // ===== JOKER SELECTION =====
  if (rs.phase === "joker-selection") {
    if (intent.type === "action" && intent.action.startsWith("joker-")) {
      if (!rs.pendingJokerCardId) {
        return { valid: false, reason: "No pending Joker", engineEvents: [] };
      }

      const card = Object.values(state.allCards).find(
        (c) => c.id === rs.pendingJokerCardId
      );
      if (!card || card.rank !== "Joker") {
        return { valid: false, reason: "Invalid Joker card", engineEvents: [] };
      }

      // Parse the joker action
      const parts = intent.action.split("-");
      const jokerMode = parts[1] as "high" | "low";
      const jokerSuit = parts[2];
      const isLeading = rs.currentTrick.length === 0;

      if (jokerMode !== "high" && jokerMode !== "low") {
        return { valid: false, reason: "Invalid Joker mode", engineEvents: [] };
      }

      if (jokerSuit && !SUITS.includes(jokerSuit as (typeof SUITS)[number])) {
        return { valid: false, reason: "Invalid Joker suit", engineEvents: [] };
      }

      if (isLeading && !jokerSuit) {
        return {
          valid: false,
          reason: "Must choose a suit when leading a Joker",
          engineEvents: [],
        };
      }

      // Get player's hand
      const handPile = state.piles[`hand-${intent.playerId}`];
      if (
        !handPile ||
        !handPile.cards ||
        !handPile.cards.some((c) => c.id === card.id)
      ) {
        return { valid: false, reason: "Card not in hand", engineEvents: [] };
      }

      const hand = handPile.cards as Card[];

      // Validate play
      const leadCardIsHighJoker =
        rs.currentTrick.length > 0 &&
        rs.currentTrick[0].isJoker &&
        rs.currentTrick[0].jokerMode === "high";

      const highJokerSuit = leadCardIsHighJoker
        ? rs.currentTrick[0].jokerSuit || null
        : null;

      const playValidation = isValidPlay(
        card,
        hand,
        rs.leadSuit,
        rs.trumpSuit,
        leadCardIsHighJoker,
        highJokerSuit
      );

      if (!playValidation.valid) {
        return {
          valid: false,
          reason: playValidation.reason,
          engineEvents: [],
        };
      }

      // Play the Joker
      events.push({
        type: "move-cards",
        cardIds: [card.id],
        fromPileId: `hand-${intent.playerId}`,
        toPileId: "trick",
      });

      const newTrick = [
        ...rs.currentTrick,
        {
          player: intent.playerId,
          cardId: card.id,
          suit: card.suit,
          rank: card.rank,
          isJoker: true,
          jokerMode,
          jokerSuit,
        },
      ];

      // Set lead suit if this is the first card
      let newLeadSuit = rs.leadSuit;
      if (rs.currentTrick.length === 0) {
        newLeadSuit = jokerSuit || null;
      }

      const player = state.players.find((p) => p.id === intent.playerId);
      const jokerDesc = ` as ${jokerMode}${jokerSuit ? ` ${jokerSuit}` : ""}`;

      events.push({
        type: "announce",
        text: `${player?.name} plays Joker${jokerDesc}`,
      });

      // Check if trick is complete
      if (newTrick.length === 4) {
        // Determine winner
        const winner = determineTrickWinner(
          newTrick,
          rs.trumpSuit,
          newLeadSuit
        );
        const winnerName = state.players.find((p) => p.id === winner)?.name;

        events.push({
          type: "announce",
          text: `${winnerName} wins the trick`,
        });

        // Move cards to winner's tricks pile
        const trickCardIds = newTrick.map((c) => c.cardId) as [
          number,
          ...number[],
        ];
        events.push({
          type: "move-cards",
          cardIds: trickCardIds,
          fromPileId: "trick",
          toPileId: `tricks-${winner}`,
        });

        const newTricksWon = { ...rs.tricksWon };
        newTricksWon[winner] = (newTricksWon[winner] || 0) + 1;

        // Check if hand is complete
        const totalTricks = Object.values(newTricksWon).reduce(
          (a, b) => a + b,
          0
        );
        if (totalTricks === rs.cardsThisHand) {
          // Hand complete - calculate scores
          const handScores: Record<string, number> = {};
          const newSetSuccesses = { ...rs.setSuccesses };

          for (const player of state.players) {
            const bid = rs.bids.find((b) => b.player === player.id)?.bid || 0;
            const won = newTricksWon[player.id] || 0;
            let score = 0;

            if (bid === won) {
              // Made the bid exactly
              if (bid === 0) {
                // Pass and made it
                score = 50;
              } else if (bid === rs.cardsThisHand) {
                // Bid all tricks and made it
                score = 100 * bid;
              } else {
                // Normal successful bid
                score = 50 * bid + 50;
              }

              // Track success for set bonus
              if (!newSetSuccesses[player.id]) {
                newSetSuccesses[player.id] = [];
              }
              newSetSuccesses[player.id].push(score);
            } else {
              // Failed bid
              score = 10 * won;
            }

            handScores[player.id] = score;
          }

          // Update set and game scores
          const newSetScores = { ...rs.setScores };
          const newGameScores = { ...rs.gameScores };
          for (const player of state.players) {
            newSetScores[player.id] += handScores[player.id];
            newGameScores[player.id] += handScores[player.id];
          }

          const scoreRecap = state.players
            .map((p) => {
              const bid = rs.bids.find((b) => b.player === p.id)?.bid || 0;
              const won = newTricksWon[p.id] || 0;
              const made = bid === won ? "✓" : "✗";
              return `${p.name}: ${bid}/${won} ${made} +${handScores[p.id]}`;
            })
            .join(", ");

          const handEndedState: JokerRulesState = {
            ...rs,
            phase: "hand-ended",
            currentTrick: [],
            leadSuit: null,
            tricksWon: newTricksWon,
            handScores,
            setScores: newSetScores,
            gameScores: newGameScores,
            setSuccesses: newSetSuccesses,
            pendingJokerCardId: null,
            recap: [
              ...rs.recap,
              `Hand ${rs.currentHandInSet} ended: ${scoreRecap}`,
            ],
          };

          events.push({
            type: "set-rules-state",
            rulesState: handEndedState,
          });

          const nextDealerSeat = (rs.dealerSeat + 1) % 4;
          const nextDealer = state.players[nextDealerSeat];

          events.push({
            type: "set-current-player",
            player: nextDealer?.id ?? null,
          });

          events.push({
            type: "set-scoreboards",
            scoreboards: [
              buildScoreboard(
                state.players,
                handEndedState,
                `Hand ${rs.currentHandInSet} Complete`
              ),
            ],
          });

          events.push({
            type: "set-actions",
            actions: {
              rows: 1,
              cols: 1,
              cells: [
                {
                  id: "next-hand",
                  label: "Next Hand",
                  enabled: true,
                  row: 0,
                  col: 0,
                },
              ],
            },
          });

          return { valid: true, engineEvents: events };
        } else {
          // Trick complete, winner leads next trick
          events.push({
            type: "set-rules-state",
            rulesState: {
              ...rs,
              phase: "playing",
              currentTrick: [],
              leadSuit: null,
              tricksWon: newTricksWon,
              pendingJokerCardId: null,
              recap: [...rs.recap, `Trick ${totalTricks}: ${winnerName} wins`],
            },
          });

          events.push({
            type: "set-current-player",
            player: winner,
          });

          events.push({
            type: "set-actions",
            actions: { rows: 0, cols: 0, cells: [] },
          });

          return { valid: true, engineEvents: events };
        }
      } else {
        // Trick continues
        const nextPlayerIndex =
          (state.players.findIndex((p) => p.id === intent.playerId) + 1) % 4;
        const nextPlayer = state.players[nextPlayerIndex];

        events.push({
          type: "set-rules-state",
          rulesState: {
            ...rs,
            phase: "playing",
            currentTrick: newTrick,
            leadSuit: newLeadSuit,
            pendingJokerCardId: null,
          },
        });

        events.push({
          type: "set-current-player",
          player: nextPlayer.id,
        });

        events.push({
          type: "set-actions",
          actions: { rows: 0, cols: 0, cells: [] },
        });

        return { valid: true, engineEvents: events };
      }
    }
  }

  // ===== HAND ENDED =====
  if (rs.phase === "hand-ended") {
    if (intent.type === "action" && intent.action === "next-hand") {
      const totalHandsInSet = getTotalHandsInSet(rs.currentSet);

      if (rs.currentHandInSet < totalHandsInSet) {
        // Next hand in same set
        const nextHandInSet = rs.currentHandInSet + 1;
        const nextDealer = (rs.dealerSeat + 1) % 4;
        const cardsThisHand = getCardsForHand(rs.currentSet, nextHandInSet);

        const nextRulesState: JokerRulesState = {
          ...rs,
          phase: "dealing",
          hasDealt: false,
          currentHandInSet: nextHandInSet,
          cardsThisHand,
          dealerSeat: nextDealer,
          bids: [],
          pendingJokerCardId: null,
          currentTrick: [],
          leadSuit: null,
          trumpSuit: null,
          tricksWon: {},
          handScores: {},
          recap: [
            ...rs.recap,
            `Set ${rs.currentSet}, Hand ${nextHandInSet}: ${cardsThisHand} cards each`,
          ],
        };

        events.push(...buildDealEvents(state, nextRulesState));

        return { valid: true, engineEvents: events };
      } else {
        // Set complete
        const nextDealerSeat = (rs.dealerSeat + 1) % 4;
        const nextDealer = state.players[nextDealerSeat];

        events.push({
          type: "set-rules-state",
          rulesState: {
            ...rs,
            phase: "set-ended",
          },
        });

        events.push({
          type: "set-current-player",
          player: nextDealer?.id ?? null,
        });

        events.push({
          type: "set-actions",
          actions: {
            rows: 1,
            cols: 1,
            cells: [
              {
                id: "next-set",
                label: "Next Set",
                enabled: true,
                row: 0,
                col: 0,
              },
            ],
          },
        });

        return { valid: true, engineEvents: events };
      }
    }
  }

  // ===== SET ENDED =====
  if (rs.phase === "set-ended") {
    if (intent.type === "action" && intent.action === "next-set") {
      // Calculate set bonuses
      const setBonuses: Record<string, number> = {};
      const newGameScores = { ...rs.gameScores };

      for (const player of state.players) {
        const successes = rs.setSuccesses[player.id] || [];
        const totalHandsInSet = getTotalHandsInSet(rs.currentSet);

        if (successes.length === totalHandsInSet) {
          // Player succeeded on all hands in set
          const maxScore = Math.max(...successes);
          setBonuses[player.id] = maxScore;
          newGameScores[player.id] += maxScore;
        } else {
          setBonuses[player.id] = 0;
        }
      }

      const bonusRecap = state.players
        .map((p) => {
          const bonus = setBonuses[p.id];
          return bonus > 0 ? `${p.name}: +${bonus} (set bonus)` : null;
        })
        .filter(Boolean)
        .join(", ");

      if (rs.currentSet < 4) {
        // Next set
        const nextSet = rs.currentSet + 1;
        const nextDealer = (rs.dealerSeat + 1) % 4;
        const cardsThisHand = getCardsForHand(nextSet, 1);

        // Reset set tracking
        const newSetScores: Record<string, number> = {};
        const newSetSuccesses: Record<string, number[]> = {};
        state.players.forEach((p) => {
          newSetScores[p.id] = 0;
          newSetSuccesses[p.id] = [];
        });

        const recapWithBonus = bonusRecap
          ? [...rs.recap, `Set ${rs.currentSet} ended: ${bonusRecap}`]
          : rs.recap;

        const nextRulesState: JokerRulesState = {
          ...rs,
          phase: "dealing",
          hasDealt: false,
          currentSet: nextSet,
          currentHandInSet: 1,
          cardsThisHand,
          dealerSeat: nextDealer,
          bids: [],
          pendingJokerCardId: null,
          currentTrick: [],
          leadSuit: null,
          trumpSuit: null,
          tricksWon: {},
          handScores: {},
          setScores: newSetScores,
          gameScores: newGameScores,
          setSuccesses: newSetSuccesses,
          recap: [
            ...recapWithBonus,
            `Set ${nextSet}, Hand 1: ${cardsThisHand} cards each`,
          ],
        };

        events.push(...buildDealEvents(state, nextRulesState));

        return { valid: true, engineEvents: events };
      } else {
        // Game complete
        const recapWithBonus = bonusRecap
          ? [...rs.recap, `Set 4 ended: ${bonusRecap}`, "Game complete!"]
          : [...rs.recap, "Game complete!"];

        events.push({
          type: "set-rules-state",
          rulesState: {
            ...rs,
            phase: "game-ended",
            gameScores: newGameScores,
            recap: recapWithBonus,
          },
        });

        events.push({
          type: "set-current-player",
          player: null,
        });

        events.push({
          type: "set-actions",
          actions: { rows: 0, cols: 0, cells: [] },
        });

        // Show final scores
        const finalScores = state.players
          .map((p) => ({ id: p.id, name: p.name, score: newGameScores[p.id] }))
          .sort((a, b) => b.score - a.score);

        const topScore = finalScores[0]?.score ?? 0;
        const topPlayers = finalScores.filter((p) => p.score === topScore);
        const winnerId = topPlayers.length === 1 ? topPlayers[0].id : null;

        events.push({ type: "set-winner", winner: winnerId });

        const finalScoreboardCells: ScoreboardCell[] = [
          { row: 0, col: 0, text: "Player", role: "header", align: "left" },
          { row: 0, col: 1, text: "Score", role: "header", align: "right" },
        ];

        finalScores.forEach((p, idx) => {
          const row = idx + 1;
          finalScoreboardCells.push(
            { row, col: 0, text: p.name, role: "body", align: "left" },
            { row, col: 1, text: `${p.score}`, align: "right" }
          );
        });

        events.push({
          type: "set-scoreboards",
          scoreboards: [
            {
              id: "final-scores",
              title: "Final Scores",
              rows: finalScores.length + 1,
              cols: 2,
              cells: finalScoreboardCells,
            },
          ],
        });

        if (winnerId) {
          events.push({
            type: "announce",
            text: `${finalScores[0].name} wins with ${finalScores[0].score} points!`,
          });
        } else {
          events.push({
            type: "announce",
            text: `The game ends in a tie at ${topScore} points.`,
          });
        }

        return { valid: true, engineEvents: events };
      }
    }
  }

  return {
    valid: false,
    reason: "Invalid action for current phase",
    engineEvents: [],
  };
};

const listLegalIntentsForPlayer: GameRuleModule["listLegalIntentsForPlayer"] = (
  state: ValidationState,
  playerId: string
): ClientIntent[] => {
  const intents: ClientIntent[] = [];
  const rs = state.rulesState as JokerRulesState;
  const gameId = state.gameId;

  // Not this player's turn
  if (state.currentPlayer && state.currentPlayer !== playerId) {
    return intents;
  }

  // Game ended
  if (state.winner) {
    return intents;
  }

  // Initial phase: only start-game
  if (rs.phase === "initial") {
    const candidate: ClientIntent = {
      type: "action",
      gameId,
      playerId,
      action: "start-game",
    };
    if (validate(state, candidate).valid) {
      intents.push(candidate);
    }
    return intents;
  }

  // Dealing phase: only start-game action
  if (rs.phase === "dealing") {
    const candidate: ClientIntent = {
      type: "action",
      gameId,
      playerId,
      action: "start-game",
    };
    if (validate(state, candidate).valid) {
      intents.push(candidate);
    }
    return intents;
  }

  // Bidding phase: all bid actions
  if (rs.phase === "bidding") {
    for (let bid = 0; bid <= rs.cardsThisHand; bid++) {
      const candidate: ClientIntent = {
        type: "action",
        gameId,
        playerId,
        action: `bid-${bid}`,
      };
      if (validate(state, candidate).valid) {
        intents.push(candidate);
      }
    }
    return intents;
  }

  // Playing phase: all card plays from hand
  if (rs.phase === "playing") {
    const hand = state.piles[`hand-${playerId}`];
    if (hand?.cards) {
      for (const card of hand.cards) {
        const candidate: ClientIntent = {
          type: "move",
          gameId,
          playerId,
          fromPileId: `hand-${playerId}`,
          toPileId: "trick",
          cardId: card.id,
        };
        if (validate(state, candidate).valid) {
          intents.push(candidate);
        }
      }
    }
    return intents;
  }

  // Joker selection phase: all mode and suit options
  if (rs.phase === "joker-selection") {
    const isLeading = rs.currentTrick.length === 0;

    if (isLeading) {
      for (const suit of SUITS) {
        const highCandidate: ClientIntent = {
          type: "action",
          gameId,
          playerId,
          action: `joker-high-${suit}`,
        };
        if (validate(state, highCandidate).valid) {
          intents.push(highCandidate);
        }
        const lowCandidate: ClientIntent = {
          type: "action",
          gameId,
          playerId,
          action: `joker-low-${suit}`,
        };
        if (validate(state, lowCandidate).valid) {
          intents.push(lowCandidate);
        }
      }
    } else {
      for (const mode of ["high", "low"]) {
        const candidate: ClientIntent = {
          type: "action",
          gameId,
          playerId,
          action: `joker-${mode}`,
        };
        if (validate(state, candidate).valid) {
          intents.push(candidate);
        }
      }
    }
    return intents;
  }

  // Hand ended phase: next-hand action
  if (rs.phase === "hand-ended") {
    const candidate: ClientIntent = {
      type: "action",
      gameId,
      playerId,
      action: "next-hand",
    };
    if (validate(state, candidate).valid) {
      intents.push(candidate);
    }
    return intents;
  }

  // Set ended phase: next-set action
  if (rs.phase === "set-ended") {
    const candidate: ClientIntent = {
      type: "action",
      gameId,
      playerId,
      action: "next-set",
    };
    if (validate(state, candidate).valid) {
      intents.push(candidate);
    }
    return intents;
  }

  return intents;
};

export const gamePlugin: GamePlugin = {
  id: "joker",
  gameName: "Joker",
  ruleModule: {
    validate,
    listLegalIntentsForPlayer,
  },
  validationHints: {
    sharedPileIds: ["deck", "trick"],
    isPileAlwaysVisibleToRules: (pileId) =>
      pileId.startsWith("hand-") || pileId.startsWith("tricks-"),
  },
};
