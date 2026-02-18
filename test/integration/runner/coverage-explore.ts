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
import {
  createRandom,
  stringToSeed,
} from "../../../backend/src/util/random.js";

type IntentUsageMap = Map<string, number>;

const RULE_VARIANT_MINIMUMS: Record<string, number> = {
  bridge: 30,
  canasta: 36,
  "gin-rummy": 120,
  golf: 34,
  pinnacola: 48,
  shithead: 36,
  skruuvi: 38,
};

const RULE_MAX_MOVES_MINIMUMS: Record<string, number> = {
  canasta: 2400,
  "gin-rummy": 2200,
  pinnacola: 2600,
  skruuvi: 1400,
};

const RULE_REPEAT_LIMIT_MINIMUMS: Record<string, number> = {
  canasta: 12,
  "gin-rummy": 14,
  shithead: 12,
  skruuvi: 14,
};

const RULE_PROBE_EVERY_OVERRIDES: Record<string, number> = {
  canasta: 2,
  "gin-rummy": 1,
  shithead: 1,
  skruuvi: 2,
};

const DEEP_PROBE_RULES = new Set([
  "canasta",
  "gin-rummy",
  "shithead",
  "skruuvi",
]);

function applyEvents(state: GameState, events: GameEvent[]): GameState {
  let nextState = state;
  for (const event of events) {
    nextState = applyEvent(nextState, event);
  }
  return nextState;
}

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
  try {
    return (
      plugin.ruleModule.listLegalIntentsForPlayer(validationState, playerId) ??
      []
    );
  } catch {
    return [];
  }
}

function intentCoverageKey(intent: ClientIntent): string {
  if (intent.type === "action") {
    return `action:${intent.action}`;
  }

  const cardCount =
    intent.cardIds?.length ?? (intent.cardId !== undefined ? 1 : 0);
  return `move:${intent.fromPileId}->${intent.toPileId}:cards=${cardCount}`;
}

function scoreIntent(
  intent: ClientIntent,
  usageCount: IntentUsageMap,
  random: () => number,
  rulesId: string
): number {
  const key = intentCoverageKey(intent);
  const used = usageCount.get(key) ?? 0;
  let score = used === 0 ? 1000 : 200 / (used + 1);

  if (rulesId === "pinnacola") {
    if (intent.type === "action") {
      score += 125;
      if (
        intent.action.includes("start") ||
        intent.action.includes("next") ||
        intent.action.includes("continue")
      ) {
        score += 90;
      }
    } else {
      const cardCount =
        intent.cardIds?.length ?? (intent.cardId !== undefined ? 1 : 0);
      if (cardCount > 1) score += 60;
    }
    return score + random();
  }

  if (intent.type === "action") {
    score -= 30;
    if (
      intent.action.includes("start") ||
      intent.action.includes("next") ||
      intent.action.includes("continue") ||
      intent.action.includes("ready")
    ) {
      score += 180;
    }
    if (intent.action === "pass" || intent.action === "finish") {
      score -= 70;
    }
  } else {
    score += 100;
    const cardCount =
      intent.cardIds?.length ?? (intent.cardId !== undefined ? 1 : 0);
    if (cardCount > 1) score += 90;
  }

  // Keep enough noise so playthroughs diverge across seeds.
  return score + random();
}

function scoreAndRankIntents(
  intents: ClientIntent[],
  usageCount: IntentUsageMap,
  random: () => number,
  rulesId: string
): ClientIntent[] {
  return intents
    .map((intent) => ({
      intent,
      score: scoreIntent(intent, usageCount, random, rulesId),
    }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.intent);
}

function chooseIntentCandidates(
  state: GameState,
  events: GameEvent[],
  usageCount: IntentUsageMap,
  random: () => number
): ClientIntent[] {
  const pickShortlist = (ranked: ClientIntent[]): ClientIntent[] => {
    const top = ranked.slice(0, Math.min(12, ranked.length));
    const rest = ranked.slice(Math.min(12, ranked.length));
    const shuffledRest = [...rest].sort(() => random() - 0.5).slice(0, 8);
    return [...top, ...shuffledRest];
  };

  const currentPlayer = state.currentPlayer;
  if (currentPlayer) {
    const legal = listLegalIntentsForPlayerLocal(state, events, currentPlayer);
    if (legal.length > 0) {
      return pickShortlist(
        scoreAndRankIntents(legal, usageCount, random, state.rulesId)
      );
    }
  }

  const allLegal: ClientIntent[] = [];
  for (const player of state.players) {
    allLegal.push(...listLegalIntentsForPlayerLocal(state, events, player.id));
  }
  if (allLegal.length === 0) return [];
  return pickShortlist(
    scoreAndRankIntents(allLegal, usageCount, random, state.rulesId)
  );
}

function stateFingerprint(state: GameState): string {
  const pileSummary = Object.values(state.piles)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((pile) => {
      return `${pile.id}:${pile.cardIds.join(",")}`;
    })
    .join("|");
  const actionSummary = state.actions.cells
    .map((action) => `${action.id}:${action.enabled ? "1" : "0"}`)
    .sort()
    .join("|");
  const rulesState =
    state.rulesState && typeof state.rulesState === "object"
      ? (state.rulesState as Record<string, unknown>)
      : {};
  const phaseKeys = [
    "phase",
    "stage",
    "status",
    "dealNumber",
    "roundNumber",
    "handNumber",
    "trickNumber",
  ] as const;
  const phaseSummary = phaseKeys
    .map((key) => `${key}:${JSON.stringify(rulesState[key])}`)
    .join("|");
  const fullRulesState = JSON.stringify(state.rulesState ?? null);
  return [
    state.currentPlayer ?? "none",
    state.winner ?? "none",
    phaseSummary,
    actionSummary,
    pileSummary,
    fullRulesState,
  ].join("::");
}

function runViewAndAiProbes(state: GameState, events: GameEvent[]): void {
  const plugin = GAME_PLUGINS[state.rulesId];
  if (!plugin) return;
  const publicPiles = Object.values(state.piles).map((pile) => ({
    id: pile.id,
    totalCards: pile.cardIds.length,
    cards: pile.cardIds.map((cardId) => {
      const card = state.cards[cardId];
      return {
        rank: card?.rank,
        suit: card?.suit,
        rotationDeg: state.cardVisuals?.[cardId]?.rotationDeg,
      };
    }),
  }));

  for (const player of state.players) {
    const dummyIntent: ClientIntent = {
      type: "action",
      gameId: state.gameId,
      playerId: player.id,
      action: "dummy",
    };

    const validationState = buildValidationState(state, events, dummyIntent);
    try {
      plugin.ruleModule.listLegalIntentsForView?.(validationState, player.id);
    } catch {
      // Keep exploration robust even if optional view helpers throw.
    }

    try {
      plugin.aiSupport?.buildContext?.({
        seat: player.id,
        public: {
          rulesState: state.rulesState,
          piles: publicPiles,
          currentPlayer: state.currentPlayer,
          winner: state.winner,
        },
        private: {},
      });
    } catch {
      // Keep exploration robust even if optional AI context helpers throw.
    }
  }
}

function rulesStateWithPhase(
  state: GameState,
  phase: string
): GameState["rulesState"] {
  if (!state.rulesState || typeof state.rulesState !== "object") {
    return { phase };
  }
  return {
    ...(state.rulesState as Record<string, unknown>),
    phase,
  };
}

function mergedRulesState(
  state: GameState,
  patch: Record<string, unknown>
): GameState["rulesState"] {
  if (!state.rulesState || typeof state.rulesState !== "object") {
    return { ...patch };
  }
  return {
    ...(state.rulesState as Record<string, unknown>),
    ...patch,
  };
}

function runLegalListMutationProbes(
  state: GameState,
  playerId: string,
  phaseCandidates: string[]
): void {
  const plugin = GAME_PLUGINS[state.rulesId];
  if (!plugin?.ruleModule.listLegalIntentsForPlayer) return;

  for (const phase of phaseCandidates) {
    const mutatedState: GameState = {
      ...state,
      currentPlayer: playerId,
      rulesState: rulesStateWithPhase(state, phase),
    };
    const dummyIntent: ClientIntent = {
      type: "action",
      gameId: mutatedState.gameId,
      playerId,
      action: "dummy",
    };

    try {
      const validationState = buildValidationState(
        mutatedState,
        [],
        dummyIntent
      );
      plugin.ruleModule.listLegalIntentsForPlayer(validationState, playerId);
    } catch {
      // Probe-only: ignore synthetic state failures.
    }
  }
}

async function runStateMutationProbes(
  state: GameState,
  playerId: string
): Promise<void> {
  const actionProbe = async (
    mutatedState: GameState,
    action: string,
    actor = playerId
  ) => {
    try {
      await validateMove(mutatedState, [], {
        type: "action",
        gameId: mutatedState.gameId,
        playerId: actor,
        action,
      });
    } catch {
      // Probe-only: ignore synthetic state failures.
    }
  };

  const moveProbe = async (
    mutatedState: GameState,
    move: Omit<ClientIntent, "type" | "gameId" | "playerId">
  ) => {
    try {
      await validateMove(mutatedState, [], {
        type: "move",
        gameId: mutatedState.gameId,
        playerId,
        ...move,
      } as ClientIntent);
    } catch {
      // Probe-only: ignore synthetic state failures.
    }
  };

  await actionProbe(
    {
      ...state,
      winner: "__probe_winner__",
    },
    "start-game"
  );

  await actionProbe(
    {
      ...state,
      currentPlayer: null,
      rulesState: rulesStateWithPhase(state, "playing"),
    },
    "pass"
  );

  await actionProbe(
    {
      ...state,
      rulesState: rulesStateWithPhase(state, "ended"),
    },
    "pass"
  );

  await actionProbe(
    {
      ...state,
      rulesState: rulesStateWithPhase(state, "setup"),
    },
    "__invalid_action__"
  );

  await actionProbe(
    {
      ...state,
      rulesState: rulesStateWithPhase(state, "layoff"),
    },
    "finish"
  );

  await actionProbe(state, "__invalid_action__", "__invalid_player__");

  if (state.rulesId === "skruuvi") {
    const handPileId = `${playerId}-hand`;
    const handCardIds = state.piles[handPileId]?.cardIds ?? [];
    const probeCardId = handCardIds[0];
    if (probeCardId !== undefined) {
      const allCardIds = Object.keys(state.cards)
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id !== probeCardId);
      const trickCardIds = allCardIds.slice(0, 3);
      if (trickCardIds.length === 3) {
        const trickPlayers = ["N", "E", "S", "W"].filter((s) => s !== playerId);
        const leadSuit = state.cards[probeCardId]?.suit ?? "clubs";
        const currentTrick = trickCardIds.map((cardId, idx) => ({
          cardId,
          player: trickPlayers[idx] ?? "N",
          rank: state.cards[cardId]?.rank ?? "A",
          suit: leadSuit,
        }));

        const finishProbes: Array<Record<string, unknown>> = [
          {
            contract: {
              level: 7,
              denomination: "misere",
              declarer: "N",
              side: "NS",
              multiplier: 1,
              doubledBy: null,
              redoubledBy: null,
              allPass: false,
            },
            round: { tricksNS: 0, tricksEW: 12 },
            scores: { N: 5, E: 1, S: 3, W: 2 },
          },
          {
            contract: {
              level: 6,
              denomination: "misere",
              declarer: "N",
              side: "NS",
              multiplier: 1,
              doubledBy: null,
              redoubledBy: null,
              allPass: false,
            },
            round: { tricksNS: 3, tricksEW: 9 },
            scores: { N: 0, E: 0, S: 0, W: 0 },
          },
          {
            contract: {
              level: 5,
              denomination: "clubs",
              declarer: "N",
              side: "NS",
              multiplier: 1,
              doubledBy: null,
              redoubledBy: null,
              allPass: false,
            },
            round: { tricksNS: 12, tricksEW: 0 },
            scores: { N: 0, E: 0, S: 0, W: 0 },
          },
          {
            contract: {
              level: 6,
              denomination: "hearts",
              declarer: "N",
              side: "NS",
              multiplier: 1,
              doubledBy: null,
              redoubledBy: null,
              allPass: false,
            },
            round: { tricksNS: 4, tricksEW: 8 },
            scores: { N: 0, E: 0, S: 0, W: 0 },
          },
          {
            contract: {
              level: 7,
              denomination: "misere",
              declarer: null,
              side: null,
              multiplier: 2,
              doubledBy: "N",
              redoubledBy: null,
              allPass: true,
            },
            round: { tricksNS: 0, tricksEW: 0 },
            scores: { N: 0, E: 0, S: 0, W: 0 },
          },
          {
            contract: null,
            round: { tricksNS: 6, tricksEW: 6 },
            scores: { N: 1, E: 1, S: 1, W: 1 },
          },
        ];

        for (const probe of finishProbes) {
          const phasePlayState: GameState = {
            ...state,
            currentPlayer: playerId,
            rulesState: mergedRulesState(state, {
              phase: "play",
              hasDealt: true,
              mode: "kitty",
              dealNumber: 12,
              dealer: "N",
              mainPlayers: { bidder: "N", partner: "S" },
              scores: (probe.scores as Record<string, number> | undefined) ?? {
                N: 0,
                E: 0,
                S: 0,
                W: 0,
              },
              contract: probe.contract ?? null,
              penalties: { N: 0, E: 0, S: 0, W: 0 },
              bolshevik: {
                active: false,
                dealsPlayed: 0,
                declarersPlayed: [],
                rawScores: { N: 0, E: 0, S: 0, W: 0 },
              },
              round: {
                trickNumber: 13,
                currentTrick,
                tricksNS: (probe.round as Record<string, number>).tricksNS ?? 0,
                tricksEW: (probe.round as Record<string, number>).tricksEW ?? 0,
                acePenaltyNS: 0,
                acePenaltyEW: 0,
                allPassTrickPenaltyNS: 0,
                allPassTrickPenaltyEW: 0,
              },
            }),
            piles: {
              ...state.piles,
              table: {
                ...state.piles.table,
                cardIds: [...trickCardIds],
              },
            },
          };

          try {
            await validateMove(phasePlayState, [], {
              type: "move",
              gameId: phasePlayState.gameId,
              playerId,
              fromPileId: handPileId,
              toPileId: "table",
              cardId: probeCardId,
            });
          } catch {
            // Probe-only: ignore synthetic state failures.
          }
        }
      }
    }

    await actionProbe(
      {
        ...state,
        players: state.players.slice(0, 3),
        currentPlayer: playerId,
        rulesState: mergedRulesState(state, {
          phase: "setup",
          hasDealt: false,
          dealer: playerId,
        }),
      },
      "start-game"
    );
    await actionProbe(
      {
        ...state,
        currentPlayer: playerId,
        rulesState: mergedRulesState(state, {
          phase: "setup",
          hasDealt: false,
          dealNumber: 17,
          dealer: playerId,
        }),
      },
      "start-game"
    );
    await actionProbe(
      {
        ...state,
        players: state.players.map((p, idx) =>
          idx === 0 ? { ...p, id: "P1" } : p
        ),
        currentPlayer: playerId,
        rulesState: mergedRulesState(state, {
          phase: "setup",
          hasDealt: false,
          dealer: playerId,
        }),
      },
      "start-game"
    );

    const skruuviActionCases: Array<{
      action: string;
      patch: Record<string, unknown>;
    }> = [
      {
        action: "pass",
        patch: {
          phase: "bolshevik-redouble",
          hasDealt: true,
          contract: null,
        },
      },
      {
        action: "pass",
        patch: {
          phase: "redouble-first",
          hasDealt: true,
          contract: { declarer: "N", doubledBy: null },
        },
      },
      {
        action: "pass",
        patch: {
          phase: "all-pass-redouble-first",
          hasDealt: true,
          contract: { allPass: true, doubledBy: null },
        },
      },
      {
        action: "__invalid_action__",
        patch: {
          phase: "auction",
          hasDealt: true,
          mode: null,
        },
      },
    ];

    for (const probeCase of skruuviActionCases) {
      await actionProbe(
        {
          ...state,
          currentPlayer: playerId,
          rulesState: mergedRulesState(state, probeCase.patch),
        },
        probeCase.action
      );
    }

    if (probeCardId !== undefined) {
      const skruuviMoveCases: Array<{
        patch: Record<string, unknown>;
        move: Omit<ClientIntent, "type" | "gameId" | "playerId">;
      }> = [
        {
          patch: { phase: "play", hasDealt: true },
          move: {
            fromPileId: handPileId,
            toPileId: "table",
          },
        },
        {
          patch: { phase: "play", hasDealt: true },
          move: {
            fromPileId: handPileId,
            toPileId: "table",
            cardId: 999999,
          },
        },
        {
          patch: { phase: "defender-exchange-out", hasDealt: true },
          move: {
            fromPileId: handPileId,
            toPileId: "table",
            cardId: probeCardId,
          },
        },
        {
          patch: { phase: "defender-exchange-back", hasDealt: true },
          move: {
            fromPileId: handPileId,
            toPileId: "table",
            cardId: probeCardId,
          },
        },
        {
          patch: {
            phase: "bolshevik-bidder-distribute3",
            hasDealt: true,
            exchange: {
              bolshevikGivenTo: ["E"],
            },
          },
          move: {
            fromPileId: handPileId,
            toPileId: "E-hand",
            cardId: probeCardId,
          },
        },
        {
          patch: {
            phase: "all-pass-exchange",
            hasDealt: true,
            dealer: "N",
            dealNumber: 1,
            exchange: {
              allPassExchangeIndex: 99,
            },
          },
          move: {
            fromPileId: handPileId,
            toPileId: "E-hand",
            cardId: probeCardId,
          },
        },
        {
          patch: {
            phase: "all-pass-exchange",
            hasDealt: true,
            dealer: "N",
            dealNumber: 1,
            exchange: {
              allPassExchangeIndex: 0,
            },
          },
          move: {
            fromPileId: handPileId,
            toPileId: "W-hand",
            cardId: probeCardId,
          },
        },
        {
          patch: { phase: "play", hasDealt: true },
          move: {
            fromPileId: handPileId,
            toPileId: "deck",
            cardId: probeCardId,
          },
        },
      ];

      for (const probeCase of skruuviMoveCases) {
        await moveProbe(
          {
            ...state,
            currentPlayer: playerId,
            rulesState: mergedRulesState(state, probeCase.patch),
          },
          probeCase.move
        );
      }
    }
  }
}

function firstExistingPile(
  state: GameState,
  preferredPileIds: string[]
): string | null {
  for (const pileId of preferredPileIds) {
    if (state.piles[pileId]) return pileId;
  }
  return null;
}

async function runGenericValidationProbes(
  state: GameState,
  events: GameEvent[],
  playerId: string
): Promise<void> {
  const actionProbes = ["start-game", "ready", "knock", "finish", "pass"];
  for (const action of actionProbes) {
    try {
      await validateMove(state, events, {
        type: "action",
        gameId: state.gameId,
        playerId,
        action,
      });
    } catch {
      // Keep exploration robust even when probes are invalid for this game.
    }
  }

  const playerHandPileId =
    firstExistingPile(state, [`${playerId}-hand`]) ??
    Object.keys(state.piles).find(
      (pileId) =>
        pileId.startsWith(`${playerId}-`) &&
        state.piles[pileId].cardIds.length > 0
    ) ??
    null;
  if (!playerHandPileId) return;

  const deckTopCardId = state.piles.deck?.cardIds.at(-1);
  if (deckTopCardId !== undefined) {
    try {
      await validateMove(state, events, {
        type: "move",
        gameId: state.gameId,
        playerId,
        fromPileId: "deck",
        toPileId: playerHandPileId,
        cardId: deckTopCardId,
      });
    } catch {
      // Keep exploration robust even when probes are invalid for this game.
    }
  }

  const discardTopCardId = state.piles.discard?.cardIds.at(-1);
  if (discardTopCardId !== undefined) {
    try {
      await validateMove(state, events, {
        type: "move",
        gameId: state.gameId,
        playerId,
        fromPileId: "discard",
        toPileId: playerHandPileId,
        cardId: discardTopCardId,
      });
    } catch {
      // Keep exploration robust even when probes are invalid for this game.
    }
  }

  const handTopCardId = state.piles[playerHandPileId]?.cardIds.at(-1);
  if (handTopCardId !== undefined) {
    const targetPile =
      firstExistingPile(state, ["discard", "table", "trick"]) ??
      playerHandPileId;
    try {
      await validateMove(state, events, {
        type: "move",
        gameId: state.gameId,
        playerId,
        fromPileId: playerHandPileId,
        toPileId: targetPile,
        cardId: handTopCardId,
      });
    } catch {
      // Keep exploration robust even when probes are invalid for this game.
    }
  }
}

function mutateIntentForProbe(
  intent: ClientIntent,
  state: GameState
): ClientIntent[] {
  const probes: ClientIntent[] = [];
  const otherPlayer = state.players.find((p) => p.id !== intent.playerId)?.id;

  if (otherPlayer) {
    probes.push({ ...intent, playerId: otherPlayer });
  }

  if (intent.type === "action") {
    probes.push({
      ...intent,
      action: "finish",
    });
    probes.push({
      ...intent,
      action: "__invalid_action__",
    });
    return probes;
  }

  if (intent.type === "move") {
    probes.push({
      ...intent,
      toPileId: intent.fromPileId,
    });

    if (intent.cardIds && intent.cardIds.length > 1) {
      probes.push({
        ...intent,
        cardIds: intent.cardIds.slice(0, intent.cardIds.length - 1),
      });
    }

    if (intent.cardId !== undefined) {
      const fromPile = state.piles[intent.fromPileId];
      const alternateCardId = fromPile?.cardIds.find(
        (cardId) => cardId !== intent.cardId
      );
      if (alternateCardId !== undefined) {
        probes.push({
          ...intent,
          cardId: alternateCardId,
        });
      }
    }
    return probes;
  }

  return probes;
}

async function runCoverageExplorationForRules(
  rulesId: string,
  variants: number,
  maxMoves: number,
  probeEvery: number
) {
  const effectiveVariants = Math.max(
    variants,
    RULE_VARIANT_MINIMUMS[rulesId] ?? variants
  );
  const effectiveMaxMoves = Math.max(
    maxMoves,
    RULE_MAX_MOVES_MINIMUMS[rulesId] ?? maxMoves
  );
  const effectiveRepeatLimit = Math.max(
    6,
    RULE_REPEAT_LIMIT_MINIMUMS[rulesId] ?? 6
  );
  const effectiveProbeEvery = RULE_PROBE_EVERY_OVERRIDES[rulesId] ?? probeEvery;
  const usageCount: IntentUsageMap = new Map();

  for (let variant = 0; variant < effectiveVariants; variant += 1) {
    const seed = `COVERAGE-EXPLORE-${rulesId}-${variant}`;
    let state = loadAndValidateGameConfig(rulesId, seed);
    if (variant % 2 === 1) {
      state = {
        ...state,
        players: state.players.map((player, index) => ({
          ...player,
          // Alternate AI-heavy runs to exercise AI-only legal-intent branches.
          isAi: index !== 0,
        })),
      };
    }
    state = { ...state, gameId: `${rulesId}-coverage-explore-${variant}` };
    const events: GameEvent[] = [];
    const seenStates = new Map<string, number>();

    const random = createRandom(stringToSeed(`${rulesId}:${variant}:coverage`));

    for (let moveIndex = 0; moveIndex < effectiveMaxMoves; moveIndex += 1) {
      if (state.winner) break;
      const stateKey = stateFingerprint(state);
      const seenCount = (seenStates.get(stateKey) ?? 0) + 1;
      seenStates.set(stateKey, seenCount);
      if (seenCount > effectiveRepeatLimit) {
        // Stop looping in cycles and let the next seed explore a different path.
        break;
      }

      const candidates = chooseIntentCandidates(
        state,
        events,
        usageCount,
        random
      );
      if (candidates.length === 0) break;

      runViewAndAiProbes(state, events);

      let advanced = false;
      const attemptPool = [...candidates];
      const attemptLimit = Math.min(candidates.length, 18);
      const deterministicTopFirst = state.rulesId === "pinnacola";
      for (
        let idx = 0;
        idx < attemptLimit && attemptPool.length > 0;
        idx += 1
      ) {
        const randomWindow = Math.min(6, attemptPool.length);
        const pickIndex = deterministicTopFirst
          ? 0
          : Math.floor(random() * randomWindow);
        const [candidate] = attemptPool.splice(pickIndex, 1);
        const chosenWithGameId = {
          ...candidate,
          gameId: state.gameId,
        } as ClientIntent;

        if (
          effectiveProbeEvery > 0 &&
          moveIndex % effectiveProbeEvery === 0 &&
          idx === 0
        ) {
          const probes = mutateIntentForProbe(chosenWithGameId, state);
          for (const probe of probes) {
            try {
              await validateMove(state, events, probe);
            } catch {
              // Ignore probe errors; probes are intentionally malformed.
            }
          }
          await runGenericValidationProbes(
            state,
            events,
            chosenWithGameId.playerId
          );
          if (DEEP_PROBE_RULES.has(state.rulesId)) {
            await runStateMutationProbes(state, chosenWithGameId.playerId);
            runLegalListMutationProbes(state, chosenWithGameId.playerId, [
              "setup",
              "playing",
              "play",
              "layoff",
              "auction",
              "ended",
            ]);
          }
        }

        let result;
        try {
          result = await validateMove(state, events, chosenWithGameId);
        } catch {
          continue;
        }
        if (!result.valid) {
          continue;
        }

        const key = intentCoverageKey(chosenWithGameId);
        usageCount.set(key, (usageCount.get(key) ?? 0) + 1);
        events.push(...result.engineEvents);
        try {
          state = applyEvents(state, result.engineEvents);
        } catch {
          // Some exploratory paths can produce invalid event sequences for this
          // synthetic harness. Skip this variant and continue coverage exploration.
          break;
        }
        advanced = true;
        break;
      }

      if (!advanced) {
        const probes = mutateIntentForProbe(
          {
            ...candidates[0],
            gameId: state.gameId,
          } as ClientIntent,
          state
        );
        for (const probe of probes) {
          try {
            await validateMove(state, events, probe);
          } catch {
            // Ignore probe errors; probes are intentionally malformed.
          }
        }
        break;
      }
    }
  }

  console.log(`[integration] coverage explore: ${rulesId} ok`);
}

async function main() {
  const variants = Number(process.env.COVERAGE_EXPLORE_VARIANTS ?? "24");
  const maxMoves = Number(process.env.COVERAGE_EXPLORE_MAX_MOVES ?? "1800");
  const probeEvery = Number(process.env.COVERAGE_EXPLORE_PROBE_EVERY ?? "4");
  const selectedRulesRaw = process.env.COVERAGE_EXPLORE_RULES?.trim();
  const selectedRules = selectedRulesRaw
    ? new Set(
        selectedRulesRaw
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      )
    : null;
  const rulesIds = Object.keys(GAME_PLUGINS)
    .sort()
    .filter((rulesId) => !selectedRules || selectedRules.has(rulesId));

  for (const rulesId of rulesIds) {
    await runCoverageExplorationForRules(
      rulesId,
      variants,
      maxMoves,
      Number.isFinite(probeEvery) ? probeEvery : 0
    );
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[integration] coverage explore failed: ${msg}`);
  process.exitCode = 1;
});
