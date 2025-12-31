import type {
  ClientIntent,
  GameEvent,
  GameState,
} from "../../../shared/schemas.js";
import { loadAndValidateGameConfig } from "../../../backend/src/game-config.js";
import { buildValidationState } from "../../../backend/src/validation-state.js";
import { GAME_PLUGINS } from "../../../backend/src/rules/registry.js";
import { validateMove } from "../../../backend/src/rule-engine.js";
import { applyEvent } from "../../../backend/src/state.js";
import { formatCard } from "../../../backend/src/util/card-notation.js";

type InspectOptions = {
  rulesId: string;
  seed?: string;
  maxMoves: number;
};

function listLegalIntentsForPlayerLocal(
  state: GameState,
  events: GameEvent[],
  playerId: string
): ClientIntent[] {
  const plugin = GAME_PLUGINS[state.rulesId];
  if (!plugin || !plugin.ruleModule.listLegalIntentsForPlayer) return [];

  const dummyIntent: ClientIntent = {
    type: "action",
    gameId: state.gameId,
    playerId,
    action: "dummy",
  };

  const validationState = buildValidationState(state, events, dummyIntent);
  return (
    plugin.ruleModule.listLegalIntentsForPlayer(validationState, playerId) ?? []
  );
}

function applyEvents(state: GameState, events: GameEvent[]): GameState {
  return events.reduce(
    (nextState, event) => applyEvent(nextState, event),
    state
  );
}

function parseArgs(): InspectOptions {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const message =
      "Usage: tsx test/integration/runner/inspect.ts <rulesId> [seed] [maxMoves]";
    throw new Error(message);
  }

  const [rulesId, seed, maxMovesRaw] = args;
  const maxMoves = maxMovesRaw ? Number(maxMovesRaw) : 20;
  if (!Number.isFinite(maxMoves) || maxMoves <= 0) {
    throw new Error("maxMoves must be a positive number");
  }

  return { rulesId, seed, maxMoves };
}

async function main() {
  const { rulesId, seed, maxMoves } = parseArgs();
  let state = loadAndValidateGameConfig(rulesId, seed);
  const gameId = `${rulesId}-inspect`;
  state = { ...state, gameId };

  const events: GameEvent[] = [];

  for (let index = 0; index < maxMoves; index += 1) {
    if (state.winner) {
      console.log(`[inspect] winner: ${state.winner}`);
      return;
    }

    const currentPlayer = state.currentPlayer ?? state.players[0]?.id;
    if (!currentPlayer) {
      throw new Error("No current player available");
    }

    const legalIntents = listLegalIntentsForPlayerLocal(
      state,
      events,
      currentPlayer
    );

    // Annotate legal intents with human-readable card labels
    const annotatedIntents = legalIntents.map((intent) => {
      if (intent.type === "move") {
        const card = state.cards[intent.cardId];
        return {
          ...intent,
          cardLabel: card ? formatCard(card.rank, card.suit) : "unknown",
        };
      }
      return intent;
    });

    // Create a human-readable piles summary
    const pilesSummary = Object.fromEntries(
      Object.entries(state.piles).map(([id, pile]) => [
        id,
        pile.cardIds.map((cid) => {
          const c = state.cards[cid];
          return c ? `${cid}(${formatCard(c.rank, c.suit)})` : String(cid);
        }),
      ])
    );

    console.log(
      JSON.stringify(
        {
          step: index,
          currentPlayer,
          rulesState: state.rulesState,
          piles: pilesSummary,
          legalIntents: annotatedIntents,
        },
        null,
        2
      )
    );

    if (legalIntents.length === 0) {
      console.log("[inspect] no legal intents; stopping");
      return;
    }

    const chosen = legalIntents[0];
    const result = await validateMove(state, events, { ...chosen, gameId });
    if (!result.valid) {
      throw new Error(`Auto intent invalid: ${result.reason ?? "unknown"}`);
    }

    for (const event of result.engineEvents) {
      events.push(event);
    }
    state = applyEvents(state, result.engineEvents);
  }

  console.log(`[inspect] stopped after ${maxMoves} moves`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
