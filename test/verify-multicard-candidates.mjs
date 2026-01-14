#!/usr/bin/env node
/**
 * Test to verify multi-card meld candidates are actually generated
 * This directly calls listLegalIntentsForPlayer and checks the results
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const distRoot = path.join(repoRoot, "backend", "dist");

const requiredModules = [
  "rules/registry.js",
  "game-config.js",
  "validation-state.js",
  "state.js",
];

for (const moduleRel of requiredModules) {
  const modulePath = path.join(distRoot, moduleRel);
  if (!fs.existsSync(modulePath)) {
    console.error(
      `Missing ${modulePath}. Please run 'npm run build' before executing this script.`
    );
    process.exit(1);
  }
}

const [
  { GAME_PLUGINS },
  { loadAndValidateGameConfig },
  { buildValidationState },
  { applyEvent },
] = await Promise.all([
  import(pathToFileURL(path.join(distRoot, "rules/registry.js")).href),
  import(pathToFileURL(path.join(distRoot, "game-config.js")).href),
  import(pathToFileURL(path.join(distRoot, "validation-state.js")).href),
  import(pathToFileURL(path.join(distRoot, "state.js")).href),
]);

const rulesId = "canasta";
const gameConfig = loadAndValidateGameConfig(rulesId);
const plugin = GAME_PLUGINS[rulesId];
const gameId = "test-candidates";

// Try multiple seeds to find one where a player has 3+ of a kind worth enough points
const seeds = [
  "CANASTA-INTEGRATION-1",
  "TEST-SEED-123",
  "CANDIDATE-TEST-1",
  "MULTI-CARD-TEST",
];

console.log("Testing Multi-Card Meld Candidate Generation\n" + "=".repeat(60));

for (const seed of seeds) {
  console.log(`\nTesting with seed: ${seed}`);

  let state = {
    gameId,
    rulesId,
    gameName: gameConfig.gameName,
    cards: gameConfig.cards,
    seed,
    players: [
      {
        id: "P1",
        name: "P1",
        isAi: false,
        aiRuntime: "none",
        aiSponsorConnectionId: null,
      },
      {
        id: "P2",
        name: "P2",
        isAi: true,
        aiRuntime: "none",
        aiSponsorConnectionId: null,
      },
      {
        id: "P3",
        name: "P3",
        isAi: true,
        aiRuntime: "none",
        aiSponsorConnectionId: null,
      },
      {
        id: "P4",
        name: "P4",
        isAi: true,
        aiRuntime: "none",
        aiSponsorConnectionId: null,
      },
    ],
    currentPlayer: "P1",
    piles: gameConfig.piles,
    actions: gameConfig.actions,
    scoreboards: gameConfig.scoreboards,
    winner: null,
    rulesState: null,
  };

  // Start game
  const events = [];
  const startIntent = {
    type: "action",
    gameId,
    playerId: "P1",
    action: "start-game",
  };
  const startValState = buildValidationState(state, events, startIntent);
  const startResult = plugin.ruleModule.validate(startValState, startIntent);

  if (!startResult.valid) {
    console.error("Failed to start game");
    continue;
  }

  for (const event of startResult.engineEvents) {
    state = applyEvent(state, event);
    events.push(event);
  }

  // Simulate P1 drawing and discarding to advance to P2's turn
  if (state.currentPlayer === "P1") {
    const p1Hand = state.piles["P1-hand"];
    if (p1Hand && p1Hand.cardIds && p1Hand.cardIds.length > 0) {
      // Draw from deck
      const deck = state.piles["deck"];
      if (deck && deck.cardIds && deck.cardIds.length > 0) {
        const drawIntent = {
          type: "move",
          gameId,
          playerId: "P1",
          fromPileId: "deck",
          toPileId: "P1-hand",
          cardId: deck.cardIds[deck.cardIds.length - 1],
        };
        const drawValState = buildValidationState(state, events, drawIntent);
        const drawResult = plugin.ruleModule.validate(drawValState, drawIntent);
        if (drawResult.valid) {
          for (const event of drawResult.engineEvents) {
            state = applyEvent(state, event);
            events.push(event);
          }
        }
      }

      // Discard first non-wild card
      const p1HandUpdated = state.piles["P1-hand"];
      if (p1HandUpdated && p1HandUpdated.cardIds) {
        for (const cardId of p1HandUpdated.cardIds) {
          const card = state.cards[cardId];
          if (card && card.rank !== "2" && card.rank !== "JOKER") {
            const discardIntent = {
              type: "move",
              gameId,
              playerId: "P1",
              fromPileId: "P1-hand",
              toPileId: "discard",
              cardId,
            };
            const discardValState = buildValidationState(
              state,
              events,
              discardIntent
            );
            const discardResult = plugin.ruleModule.validate(
              discardValState,
              discardIntent
            );
            if (discardResult.valid) {
              for (const event of discardResult.engineEvents) {
                state = applyEvent(state, event);
                events.push(event);
              }
              break;
            }
          }
        }
      }
    }
  }

  // Now check candidates for the current player (who should be in meld-or-discard phase)
  const currentPlayer = state.currentPlayer;
  if (!currentPlayer) {
    console.log("  No current player");
    continue;
  }

  // Check if current player needs to draw first
  const rulesState = state.rulesState;
  if (rulesState && rulesState.turnPhase === "must-draw") {
    // Draw from deck for current player
    const deck = state.piles["deck"];
    if (deck && deck.cardIds && deck.cardIds.length > 0) {
      const drawIntent = {
        type: "move",
        gameId,
        playerId: currentPlayer,
        fromPileId: "deck",
        toPileId: `${currentPlayer}-hand`,
        cardId: deck.cardIds[deck.cardIds.length - 1],
      };
      const drawValState = buildValidationState(state, events, drawIntent);
      const drawResult = plugin.ruleModule.validate(drawValState, drawIntent);
      if (drawResult.valid) {
        for (const event of drawResult.engineEvents) {
          state = applyEvent(state, event);
          events.push(event);
        }
        console.log(
          `  ${currentPlayer} drew a card, now in meld-or-discard phase`
        );
      }
    }
  }

  const hand = state.piles[`${currentPlayer}-hand`];
  if (!hand || !hand.cardIds) {
    console.log(`  ${currentPlayer} has no hand`);
    continue;
  }

  // Analyze hand composition
  const cardsByRank = {};
  for (const cardId of hand.cardIds) {
    const card = state.cards[cardId];
    if (!card) continue;

    const rank = card.rank;
    if (!cardsByRank[rank]) cardsByRank[rank] = [];
    cardsByRank[rank].push({ id: cardId, ...card });
  }

  // Check for 3+ of a kind
  const threeOfAKind = Object.entries(cardsByRank).filter(
    ([rank, cards]) =>
      cards.length >= 3 && rank !== "2" && rank !== "JOKER" && rank !== "3"
  );

  console.log(`\n  ${currentPlayer} hand analysis:`);
  if (threeOfAKind.length > 0) {
    console.log(`    Has potential multi-card melds:`);
    for (const [rank, cards] of threeOfAKind) {
      const points =
        cards.length *
        (["A", "2"].includes(rank)
          ? 20
          : ["K", "Q", "J", "10", "9", "8"].includes(rank)
            ? 10
            : 5);
      console.log(
        `      ${rank}: ${cards.length} cards = ${points} points (IDs: ${cards.map((c) => c.id).join(", ")})`
      );
    }
  } else {
    console.log(`    No 3+ of a kind found`);
  }

  // Get candidates for current player
  const dummyIntent = {
    type: "action",
    gameId,
    playerId: currentPlayer,
    action: "dummy",
  };
  const valState = buildValidationState(state, events, dummyIntent);
  const candidates = plugin.ruleModule.listLegalIntentsForPlayer
    ? plugin.ruleModule.listLegalIntentsForPlayer(valState, currentPlayer)
    : [];

  // Filter for multi-card meld candidates
  const multiCardMelds = candidates.filter(
    (c) =>
      c.type === "move" &&
      c.cardIds &&
      Array.isArray(c.cardIds) &&
      c.cardIds.length >= 3
  );

  console.log(
    `    Candidates: ${candidates.length} total, ${multiCardMelds.length} multi-card melds`
  );

  if (multiCardMelds.length > 0) {
    console.log(
      `\n  ✅ SUCCESS! Multi-card candidates found for ${currentPlayer}:`
    );
    for (const candidate of multiCardMelds.slice(0, 3)) {
      console.log(`    ${candidate.fromPileId} → ${candidate.toPileId}`);
      console.log(
        `    Cards: [${candidate.cardIds.join(", ")}] (${candidate.cardIds.length} cards)`
      );
    }
    console.log("\n" + "=".repeat(60));
    console.log("✅ TEST PASSED: Multi-card candidates ARE being generated!");
    console.log("=".repeat(60));
    process.exit(0);
  } else if (candidates.length > 0) {
    console.log(`    Sample candidates:`);
    candidates.slice(0, 5).forEach((c) => {
      if (c.type === "action") {
        console.log(`      action: ${c.action}`);
      } else if (c.type === "move") {
        const cards = c.cardIds || [c.cardId];
        console.log(
          `      move: ${c.fromPileId} → ${c.toPileId} (${cards.length} card${cards.length > 1 ? "s" : ""})`
        );
      }
    });
  }

  console.log(`  No multi-card candidates found with this seed`);
}

console.log("\n" + "=".repeat(60));
console.log("⚠️  No multi-card candidates found with any seed.");
console.log("This might mean:");
console.log(
  "1. None of the seeds generated hands with 3+ of a kind worth enough points"
);
console.log("2. There's an issue with candidate generation");
console.log("=".repeat(60));
process.exit(1);
