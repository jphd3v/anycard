import type {
  ClientIntent,
  GameState,
  GameView,
  Pile,
  Player,
} from "../../shared/schemas.js";
import {
  assignCandidateId,
  buildAiCandidatesForSeat,
} from "./ai/ai-candidates.js";
import { getViewSalt } from "./state.js";
import { toViewCardId } from "./view-ids.js";
import { isPileVisibleToPlayer } from "./visibility.js";
import { GAME_PLUGINS } from "./rules/registry.js";
import { getRoomType } from "./socket.js";
import { loadGameMeta } from "./rules/meta.js";

export function buildViewForPlayer(
  state: GameState,
  viewerId: string,
  connectionId?: string
): GameView {
  const viewSalt = getViewSalt(state.gameId);
  const viewerKey = viewerId;

  const cardVisuals = state.cardVisuals as
    | Record<string, { rotationDeg?: number }>
    | undefined;
  const pileProperties = state.pileProperties;
  const players = state.players.map((player: Player) => {
    const aiRuntime =
      player.aiRuntime ??
      (player.isAi ? ("backend" as const) : ("none" as const));
    const isAiControlledByYou =
      aiRuntime === "frontend" &&
      player.aiSponsorConnectionId != null &&
      player.aiSponsorConnectionId === connectionId;

    return {
      seatId: player.id,
      name: player.name,
      aiRuntime,
      isAiControlledByYou,
    };
  });

  const sponsoredSeats = new Set(
    state.players
      .filter(
        (player) =>
          player.aiRuntime === "frontend" &&
          player.aiSponsorConnectionId != null &&
          player.aiSponsorConnectionId === connectionId
      )
      .map((player) => player.id)
  );

  const piles = (Object.values(state.piles) as Pile[]).map((pile) => {
    const visibleToPlayer = isPileVisibleToPlayer(pile, viewerId);

    const cardIdsToRender = pile.cardIds;

    const cards = cardIdsToRender.map((cardId: number) => {
      const engineCardId = cardId;
      const card = state.cards[engineCardId];
      const viewCardId = toViewCardId(engineCardId, viewSalt, viewerKey);
      return {
        id: viewCardId,
        label: visibleToPlayer ? card.label : undefined,
        rank: visibleToPlayer ? card.rank : undefined,
        suit: visibleToPlayer ? card.suit : undefined,
        faceDown: !visibleToPlayer,
        rotationDeg: cardVisuals?.[String(engineCardId)]?.rotationDeg,
      };
    });

    const overrides = pileProperties?.[pile.id];

    return {
      id: pile.id,
      label: overrides?.label ?? pile.id,
      ownerId: pile.ownerId,
      cards,
      totalCards: pile.cardIds.length,
      layout: overrides?.layout,
    };
  });

  const plugin = GAME_PLUGINS[state.rulesId];
  const ruleModule = plugin?.ruleModule;

  let scoreboards = state.scoreboards;
  try {
    const derived = ruleModule?.deriveScoreboardsForView?.(state, viewerId);
    if (derived) scoreboards = derived;
  } catch (err) {
    console.warn(
      `[view] deriveScoreboardsForView failed for rulesId="%s" viewerId="%s":`,
      state.rulesId,
      viewerId,
      err
    );
  }

  const mapCardIdForView = (engineCardId: number): number => {
    const card = state.cards[engineCardId];
    if (!card) {
      return engineCardId;
    }
    return toViewCardId(engineCardId, viewSalt, viewerKey);
  };

  const shouldMapSingleCardId = (
    key: string,
    value: unknown
  ): value is number => {
    if (typeof value !== "number") return false;
    const lower = key.toLowerCase();
    return (
      lower.includes("cardid") ||
      lower.endsWith("card") ||
      lower.endsWith("cards")
    );
  };

  const shouldMapCardIdArray = (
    key: string,
    value: unknown
  ): value is number[] => {
    if (!Array.isArray(value)) return false;
    const lower = key.toLowerCase();
    return (
      lower.includes("cardid") ||
      lower.endsWith("cardids") ||
      lower.endsWith("cards")
    );
  };

  const mapRulesStateKeyCardIds = (key: string): string => {
    if (!key.includes("cardId_")) return key;
    return key.replace(/cardId_(\d+)/g, (_match, rawId) => {
      const cardId = Number(rawId);
      if (!Number.isFinite(cardId)) return _match;
      return `cardId_${mapCardIdForView(cardId)}`;
    });
  };

  const mapRulesStateCardIds = (value: unknown, key?: string): unknown => {
    if (key && shouldMapSingleCardId(key, value)) {
      return mapCardIdForView(value);
    }
    if (key && shouldMapCardIdArray(key, value)) {
      return value.map((entry) =>
        typeof entry === "number" ? mapCardIdForView(entry) : entry
      );
    }
    if (Array.isArray(value)) {
      return value.map((entry) => mapRulesStateCardIds(entry));
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const next: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(obj)) {
        const mappedKey = mapRulesStateKeyCardIds(childKey);
        next[mappedKey] = mapRulesStateCardIds(childValue, childKey);
      }
      return next;
    }
    return value;
  };

  let mappedRulesState = state.rulesState;
  try {
    mappedRulesState = mapRulesStateCardIds(
      state.rulesState
    ) as GameState["rulesState"];
  } catch (err) {
    console.warn(
      `[view] Failed to map rulesState card ids for viewerId="%s":`,
      viewerId,
      err
    );
  }

  const sponsoredAiViews =
    sponsoredSeats.size > 0
      ? Object.fromEntries(
          Array.from(sponsoredSeats).map((seatId) => [
            seatId,
            buildViewForPlayer(state, seatId),
          ])
        )
      : undefined;

  // Determine if actions should be visible to this viewer
  // By default, actions are only visible to the current player.
  // Games can opt into showing actions to all players (e.g., Bridge bidding table)
  // by setting showActionsToAll: true in their meta.json.
  const meta = loadGameMeta(state.rulesId);
  const isCurrentPlayer = viewerId === state.currentPlayer;
  const isSpectator = viewerId === "__spectator__" || viewerId === "__god__";
  const showActions =
    meta.showActionsToAll === true || isCurrentPlayer || isSpectator;
  const visibleActions = showActions
    ? state.actions
    : { rows: 0, cols: 0, cells: [] };

  return {
    gameId: state.gameId,
    rulesId: state.rulesId,
    gameName: state.gameName,
    piles,
    winner: state.winner,
    currentPlayer: state.currentPlayer,
    currentSeatId: state.currentPlayer,
    actions: visibleActions,
    rulesState: mappedRulesState,
    scoreboards,
    seats: players,
    ...(sponsoredAiViews ? { sponsoredAiViews } : {}),
    aiCandidatesForCurrentTurn: (() => {
      const currentSeatId = state.currentPlayer;
      if (!currentSeatId) {
        return undefined;
      }

      const controlsCurrentSeat =
        (viewerId === currentSeatId && viewerId !== "__spectator__") ||
        players.some(
          (p) =>
            p.seatId === currentSeatId &&
            p.aiRuntime === "frontend" &&
            p.isAiControlledByYou
        );

      if (!controlsCurrentSeat) {
        return undefined;
      }

      const candidates = buildAiCandidatesForSeat(state, currentSeatId);

      // These intents are executed as the current seat, not the viewer of this view.
      const seatViewerKey = currentSeatId;
      const idCounter = { value: 0 };

      return candidates.map((candidate) => {
        const intent = candidate.intent as ClientIntent;
        let mappedIntent = intent;

        if (intent.type === "move") {
          const viewCardId = toViewCardId(
            intent.cardId!,
            viewSalt,
            seatViewerKey
          );
          mappedIntent = { ...intent, cardId: viewCardId };
        }

        return {
          ...candidate,
          id: assignCandidateId(mappedIntent, idCounter),
          intent: mappedIntent,
        };
      });
    })(),
    metadata: (() => {
      const metadata: Record<string, string> = {};
      const isSpectator =
        viewerId === "__spectator__" || viewerId === "__god__";
      const isGodMode = viewerId === "__god__";

      metadata.viewerId = viewerId;
      metadata.role = isSpectator ? "spectator" : "player";
      metadata.isGodMode = isGodMode ? "true" : "false";
      metadata.roomType = getRoomType(state.gameId);

      if (typeof state.seed === "string") {
        metadata.seed = state.seed;
      }
      return Object.keys(metadata).length > 0 ? metadata : undefined;
    })(),
  };
}
