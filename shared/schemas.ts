import { z } from "zod";

export const CardIdSchema = z.number().int().nonnegative();
const CardIdKeySchema = z.coerce.number().int().nonnegative();

export const CardViewIdSchema = z.number().int().nonnegative();

export const CardSchema = z.object({
  id: CardIdSchema,
  rank: z.string(),
  suit: z.string(),
  label: z.string().optional(),
});

export type CardId = z.infer<typeof CardIdSchema>;
export type CardViewId = z.infer<typeof CardViewIdSchema>;
export type Card = z.infer<typeof CardSchema>;

export const CardVisualSchema = z.object({
  rotationDeg: z.number().optional(),
});

export type CardVisual = z.infer<typeof CardVisualSchema>;

export const PileVisibilitySchema = z.enum(["public", "owner", "hidden"]);

export type PileVisibility = z.infer<typeof PileVisibilitySchema>;

export const PileLayoutSchema = z.enum([
  "complete",
  "horizontal",
  "vertical",
  "spread",
]);

export type PileLayout = z.infer<typeof PileLayoutSchema>;

export const PileSchema = z.object({
  id: z.string(),
  ownerId: z.string().nullable(),
  visibility: PileVisibilitySchema,
  cardIds: z.array(CardIdSchema),
  shuffle: z.boolean().optional(),
  shuffleGroup: z.string().optional(),
  allowReorder: z.boolean().optional(),
});

export type Pile = z.infer<typeof PileSchema>;

export const PlayerSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  isAi: z.boolean().optional(),
  aiProfileId: z.string().optional(),
  aiRuntime: z.enum(["none", "backend", "frontend"]).default("none"),
  aiSponsorConnectionId: z.string().nullable().optional(),
});

export type Player = z.infer<typeof PlayerSchema>;
export const AiRuntimeLocationSchema = PlayerSchema.shape.aiRuntime;
export type AiRuntimeLocation = z.infer<typeof AiRuntimeLocationSchema>;

// --- Grid System DSL ---

// Base interfaces for grid cells
export const BaseGridCellSchema = z.object({
  row: z.number().int().nonnegative(),
  col: z.number().int().nonnegative(),
  rowspan: z.number().int().positive().optional(),
  colspan: z.number().int().positive().optional(),
});

export type BaseGridCell = z.infer<typeof BaseGridCellSchema>;

// Action cell for input buttons
export const ActionCellSchema = BaseGridCellSchema.extend({
  /**
   * The ID sent to backend when clicked (e.g., "bid-1c", "fold").
   * MUST be unique in the grid.
   * RECOMMENDED: Use ASCII-only strings (no emojis/spaces) for reliable AI handling.
   */
  id: z.string(),
  label: z.string(), // Text displayed on the button
  enabled: z.boolean(), // Clickable state
});

export type ActionCell = z.infer<typeof ActionCellSchema>;

// Action grid
export const ActionGridSchema = z.object({
  rows: z.number().int().nonnegative(),
  cols: z.number().int().nonnegative(),
  cells: z.array(ActionCellSchema),
});

export type ActionGrid = z.infer<typeof ActionGridSchema>;

// Scoreboard cell for display
export const ScoreboardCellSchema = BaseGridCellSchema.extend({
  text: z.string(), // unicode text, may contain suit symbols etc.
  role: z.enum(["header", "body", "total", "separator"]).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
});

export const ScoreboardSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  rows: z.number().int().nonnegative(),
  cols: z.number().int().nonnegative(),
  cells: z.array(ScoreboardCellSchema),
});

export type ScoreboardCell = z.infer<typeof ScoreboardCellSchema>;
export type Scoreboard = z.infer<typeof ScoreboardSchema>;

export const PilePropertyOverridesSchema = z.object({
  layout: PileLayoutSchema.optional(),
  label: z.string().optional(),
  isHand: z.boolean().optional(),
  allowReorder: z.boolean().optional(),
});

export const GameStateSchema = z.object({
  gameId: z.string(),
  rulesId: z.string(),
  gameName: z.string(),
  seed: z.string().optional(),
  cards: z.record(CardIdKeySchema, CardSchema),
  cardVisuals: z.record(CardIdKeySchema, CardVisualSchema).optional(),
  pileProperties: z.record(z.string(), PilePropertyOverridesSchema).optional(),
  piles: z.record(z.string(), PileSchema),
  players: z.array(PlayerSchema),
  currentPlayer: z.string().nullable(),
  winner: z.string().nullable(),
  actions: ActionGridSchema,
  rulesState: z.unknown().optional(),
  scoreboards: z.array(ScoreboardSchema),
});

export type GameState = z.infer<typeof GameStateSchema>;

export const EventBaseSchema = z.object({
  id: z.number().int(),
  gameId: z.string(),
  playerId: z.string().nullable(),
  initiatedByPlayerId: z.string().nullable().optional(),
  initiatedByIntentType: z.enum(["move", "action"]).optional(),
  executorRole: z.enum(["player", "system"]).optional(),
});

export const MoveCardsEventSchema = EventBaseSchema.extend({
  type: z.literal("move-cards"),
  fromPileId: z.string(),
  toPileId: z.string(),
  cardIds: z.array(CardIdSchema).nonempty(),
  /** Optional target index for reordering within the same pile. */
  targetIndex: z.number().int().nonnegative().optional(),
});

export const SetCurrentPlayerEventSchema = EventBaseSchema.extend({
  type: z.literal("set-current-player"),
  player: z.string().nullable(),
});

export const SetWinnerEventSchema = EventBaseSchema.extend({
  type: z.literal("set-winner"),
  winner: z.string().nullable(),
});

export const SetRulesStateEventSchema = EventBaseSchema.extend({
  type: z.literal("set-rules-state"),
  rulesState: z.unknown(),
});

export const SetScoreboardsEventSchema = EventBaseSchema.extend({
  type: z.literal("set-scoreboards"),
  scoreboards: z.array(ScoreboardSchema),
});

export const SetActionsEventSchema = EventBaseSchema.extend({
  type: z.literal("set-actions"),
  actions: ActionGridSchema,
});

export const SetPileVisibilityEventSchema = EventBaseSchema.extend({
  type: z.literal("set-pile-visibility"),
  pileId: z.string(),
  visibility: PileVisibilitySchema,
});

export const SetCardVisualsEventSchema = EventBaseSchema.extend({
  type: z.literal("set-card-visuals"),
  visuals: z.record(CardIdKeySchema, CardVisualSchema),
});

export const SetPilePropertiesEventSchema = EventBaseSchema.extend({
  type: z.literal("set-pile-properties"),
  properties: z.record(z.string(), PilePropertyOverridesSchema),
});

export const AnnounceAnchorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pile"),
    pileId: z.string(),
  }),
  z.object({
    type: z.literal("screen"),
  }),
]);

export type AnnounceAnchor = z.infer<typeof AnnounceAnchorSchema>;

export const AnnounceKindSchema = z.enum(["announce", "action", "score"]);

export const AnnounceEventSchema = EventBaseSchema.extend({
  type: z.literal("announce"),
  text: z.string().min(1),
  anchor: AnnounceAnchorSchema.optional(),
  announceKind: AnnounceKindSchema.optional(),
});

export const FatalErrorEventSchema = EventBaseSchema.extend({
  type: z.literal("fatal-error"),
  message: z.string(),
  source: z.enum(["ai", "rules", "engine"]).optional(),
});

export const GameEventSchema = z.discriminatedUnion("type", [
  MoveCardsEventSchema,
  SetCurrentPlayerEventSchema,
  SetWinnerEventSchema,
  SetRulesStateEventSchema,
  SetScoreboardsEventSchema,
  SetActionsEventSchema,
  SetPileVisibilityEventSchema,
  SetCardVisualsEventSchema,
  SetPilePropertiesEventSchema,
  AnnounceEventSchema,
  FatalErrorEventSchema,
]);

const EVENT_ENVELOPE_OMIT = {
  id: true,
  gameId: true,
  playerId: true,
  initiatedByPlayerId: true,
  initiatedByIntentType: true,
  executorRole: true,
} as const;

const MoveCardsEventPayloadSchema =
  MoveCardsEventSchema.omit(EVENT_ENVELOPE_OMIT);
const SetCurrentPlayerEventPayloadSchema =
  SetCurrentPlayerEventSchema.omit(EVENT_ENVELOPE_OMIT);
const SetWinnerEventPayloadSchema =
  SetWinnerEventSchema.omit(EVENT_ENVELOPE_OMIT);
const SetRulesStateEventPayloadSchema =
  SetRulesStateEventSchema.omit(EVENT_ENVELOPE_OMIT);
const SetScoreboardsEventPayloadSchema =
  SetScoreboardsEventSchema.omit(EVENT_ENVELOPE_OMIT);
const SetActionsEventPayloadSchema =
  SetActionsEventSchema.omit(EVENT_ENVELOPE_OMIT);

const SetPileVisibilityEventPayloadSchema = SetPileVisibilityEventSchema.omit({
  ...EVENT_ENVELOPE_OMIT,
});

const SetCardVisualsEventPayloadSchema = SetCardVisualsEventSchema.omit({
  ...EVENT_ENVELOPE_OMIT,
});

const SetPilePropertiesEventPayloadSchema = SetPilePropertiesEventSchema.omit({
  ...EVENT_ENVELOPE_OMIT,
});

const AnnounceEventPayloadSchema = AnnounceEventSchema.omit({
  ...EVENT_ENVELOPE_OMIT,
});

const FatalErrorEventPayloadSchema = FatalErrorEventSchema.omit({
  ...EVENT_ENVELOPE_OMIT,
});

export const GameEventPayloadSchema = z.discriminatedUnion("type", [
  MoveCardsEventPayloadSchema,
  SetCurrentPlayerEventPayloadSchema,
  SetWinnerEventPayloadSchema,
  SetRulesStateEventPayloadSchema,
  SetScoreboardsEventPayloadSchema,
  SetActionsEventPayloadSchema,
  SetPileVisibilityEventPayloadSchema,
  SetCardVisualsEventPayloadSchema,
  SetPilePropertiesEventPayloadSchema,
  AnnounceEventPayloadSchema,
  FatalErrorEventPayloadSchema,
]);

export const MAX_GAME_SAVE_EVENTS = 10000;
export const GAME_SAVE_HASH_ALGORITHM = "fnv1a-64" as const;

type CanonicalJsonValue =
  | null
  | string
  | number
  | boolean
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function toCanonicalJsonValue(input: unknown): CanonicalJsonValue {
  if (input == null) return null;
  if (typeof input === "string") return input;
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : String(input);
  }
  if (typeof input === "boolean") return input;
  if (Array.isArray(input)) {
    return input.map((entry) => toCanonicalJsonValue(entry));
  }
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const out: Record<string, CanonicalJsonValue> = {};
    for (const key of keys) {
      out[key] = toCanonicalJsonValue(record[key]);
    }
    return out;
  }
  // Symbols/functions/undefined should not appear in schema descriptors.
  return String(input);
}

export function canonicalStringifyForSaveHash(value: unknown): string {
  return JSON.stringify(toCanonicalJsonValue(value));
}

export function hashStringFnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let idx = 0; idx < input.length; idx += 1) {
    hash ^= BigInt(input.charCodeAt(idx));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export function hashDescriptorForSave(value: unknown): string {
  return hashStringFnv1a64(canonicalStringifyForSaveHash(value));
}

const SAVE_SNAPSHOT_SCHEMA_DESCRIPTOR = {
  snapshot: {
    required: ["exportedAt", "initialState", "events"],
    optional: ["origin", "format", "executedIntents"],
  },
  origin: {
    required: ["backendCommitHash", "backendCommitUnixTs"],
  },
  format: {
    required: [
      "hashAlgorithm",
      "saveSchemaHash",
      "eventPayloadSchemaHash",
      "rulesSchemaHash",
    ],
  },
  executedIntents: {
    move: [
      "type",
      "playerId",
      "fromPileId",
      "toPileId",
      "cardId|cardIds",
      "targetIndex",
      "turnNumber",
      "timestamp",
    ],
    action: ["type", "playerId", "action", "turnNumber", "timestamp"],
  },
} as const;

const PERSISTED_EVENT_PAYLOAD_DESCRIPTOR = {
  "move-cards": [
    "type",
    "id",
    "playerId",
    "initiatedByPlayerId",
    "initiatedByIntentType",
    "executorRole",
    "fromPileId",
    "toPileId",
    "cardIds",
  ],
  "set-current-player": [
    "type",
    "id",
    "playerId",
    "initiatedByPlayerId",
    "initiatedByIntentType",
    "executorRole",
    "player",
  ],
  "set-winner": [
    "type",
    "id",
    "playerId",
    "initiatedByPlayerId",
    "initiatedByIntentType",
    "executorRole",
    "winner",
  ],
  "set-rules-state": [
    "type",
    "id",
    "playerId",
    "initiatedByPlayerId",
    "initiatedByIntentType",
    "executorRole",
    "rulesState",
  ],
  "set-scoreboards": [
    "type",
    "id",
    "playerId",
    "initiatedByPlayerId",
    "initiatedByIntentType",
    "executorRole",
    "scoreboards",
  ],
  "set-actions": [
    "type",
    "id",
    "playerId",
    "initiatedByPlayerId",
    "initiatedByIntentType",
    "executorRole",
    "actions",
  ],
  "set-pile-visibility": [
    "type",
    "id",
    "playerId",
    "initiatedByPlayerId",
    "initiatedByIntentType",
    "executorRole",
    "pileId",
    "visibility",
  ],
  "set-card-visuals": [
    "type",
    "id",
    "playerId",
    "initiatedByPlayerId",
    "initiatedByIntentType",
    "executorRole",
    "visuals",
  ],
  "set-pile-properties": [
    "type",
    "id",
    "playerId",
    "initiatedByPlayerId",
    "initiatedByIntentType",
    "executorRole",
    "properties",
  ],
  announce: [
    "type",
    "id",
    "playerId",
    "initiatedByPlayerId",
    "initiatedByIntentType",
    "executorRole",
    "text",
    "anchor",
    "announceKind",
  ],
  "fatal-error": [
    "type",
    "id",
    "playerId",
    "initiatedByPlayerId",
    "initiatedByIntentType",
    "executorRole",
    "message",
    "source",
  ],
} as const;

export const GAME_SAVE_SCHEMA_HASH = hashDescriptorForSave(
  SAVE_SNAPSHOT_SCHEMA_DESCRIPTOR
);
export const GAME_SAVE_EVENT_PAYLOAD_SCHEMA_HASH = hashDescriptorForSave(
  PERSISTED_EVENT_PAYLOAD_DESCRIPTOR
);

export const GameSaveOriginSchema = z.object({
  backendCommitHash: z.string().min(1),
  backendCommitUnixTs: z.number().int().nonnegative().nullable(),
});

export const GameSaveFormatSchema = z.object({
  hashAlgorithm: z.literal(GAME_SAVE_HASH_ALGORITHM),
  saveSchemaHash: z.string().regex(/^[0-9a-f]{16}$/),
  eventPayloadSchemaHash: z.string().regex(/^[0-9a-f]{16}$/),
  rulesSchemaHash: z.string().regex(/^[0-9a-f]{16}$/),
});

const PersistedEventIdSchema = z.number().int().nonnegative().optional();

const MoveCardsPersistedEventSchema = MoveCardsEventSchema.omit({
  id: true,
  gameId: true,
}).extend({
  id: PersistedEventIdSchema,
});
const SetCurrentPlayerPersistedEventSchema = SetCurrentPlayerEventSchema.omit({
  id: true,
  gameId: true,
}).extend({
  id: PersistedEventIdSchema,
});
const SetWinnerPersistedEventSchema = SetWinnerEventSchema.omit({
  id: true,
  gameId: true,
}).extend({
  id: PersistedEventIdSchema,
});
const SetRulesStatePersistedEventSchema = SetRulesStateEventSchema.omit({
  id: true,
  gameId: true,
}).extend({
  id: PersistedEventIdSchema,
});
const SetScoreboardsPersistedEventSchema = SetScoreboardsEventSchema.omit({
  id: true,
  gameId: true,
}).extend({
  id: PersistedEventIdSchema,
});
const SetActionsPersistedEventSchema = SetActionsEventSchema.omit({
  id: true,
  gameId: true,
}).extend({
  id: PersistedEventIdSchema,
});
const SetPileVisibilityPersistedEventSchema = SetPileVisibilityEventSchema.omit(
  {
    id: true,
    gameId: true,
  }
).extend({
  id: PersistedEventIdSchema,
});
const SetCardVisualsPersistedEventSchema = SetCardVisualsEventSchema.omit({
  id: true,
  gameId: true,
}).extend({
  id: PersistedEventIdSchema,
});
const SetPilePropertiesPersistedEventSchema = SetPilePropertiesEventSchema.omit(
  {
    id: true,
    gameId: true,
  }
).extend({
  id: PersistedEventIdSchema,
});
const AnnouncePersistedEventSchema = AnnounceEventSchema.omit({
  id: true,
  gameId: true,
}).extend({
  id: PersistedEventIdSchema,
});
const FatalErrorPersistedEventSchema = FatalErrorEventSchema.omit({
  id: true,
  gameId: true,
}).extend({
  id: PersistedEventIdSchema,
});

export const PersistedGameEventSchema = z.discriminatedUnion("type", [
  MoveCardsPersistedEventSchema,
  SetCurrentPlayerPersistedEventSchema,
  SetWinnerPersistedEventSchema,
  SetRulesStatePersistedEventSchema,
  SetScoreboardsPersistedEventSchema,
  SetActionsPersistedEventSchema,
  SetPileVisibilityPersistedEventSchema,
  SetCardVisualsPersistedEventSchema,
  SetPilePropertiesPersistedEventSchema,
  AnnouncePersistedEventSchema,
  FatalErrorPersistedEventSchema,
]);

const PersistedMoveIntentBaseSchema = z.object({
  type: z.literal("move"),
  playerId: z.string(),
  fromPileId: z.string(),
  toPileId: z.string(),
  cardId: CardIdSchema.optional(),
  cardIds: z.array(CardIdSchema).optional(),
  targetIndex: z.number().int().nonnegative().optional(),
  turnNumber: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
});

function validatePersistedMoveIntentShape(
  data: z.infer<typeof PersistedMoveIntentBaseSchema>,
  ctx: z.RefinementCtx
): void {
  const hasCardId = data.cardId !== undefined;
  const hasCardIds = data.cardIds !== undefined;

  if (hasCardId === hasCardIds) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Exactly one of 'cardId' or 'cardIds' must be provided",
    });
  }

  if (hasCardIds) {
    const cardIds = data.cardIds ?? [];
    if (cardIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cardIds array cannot be empty",
      });
    }
    const unique = new Set(cardIds);
    if (unique.size !== cardIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cardIds contains duplicate card IDs",
      });
    }
  }
}

export const PersistedActionIntentSchema = z.object({
  type: z.literal("action"),
  playerId: z.string(),
  action: z.string(),
  turnNumber: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
});

export const PersistedExecutedIntentSchema = z
  .discriminatedUnion("type", [
    PersistedMoveIntentBaseSchema,
    PersistedActionIntentSchema,
  ])
  .superRefine((data, ctx) => {
    if (data.type !== "move") return;
    validatePersistedMoveIntentShape(data, ctx);
  });

export const GameSaveSnapshotSchema = z.object({
  exportedAt: z.string().datetime(),
  origin: GameSaveOriginSchema.optional(),
  format: GameSaveFormatSchema.optional(),
  initialState: GameStateSchema,
  events: z.array(PersistedGameEventSchema).max(MAX_GAME_SAVE_EVENTS),
  executedIntents: z
    .array(PersistedExecutedIntentSchema)
    .max(MAX_GAME_SAVE_EVENTS)
    .optional(),
});

export const GameSaveExportAckSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    snapshot: GameSaveSnapshotSchema,
  }),
  z.object({
    ok: z.literal(false),
    message: z.string().min(1),
  }),
]);

export const GameSaveImportAckSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    gameId: z.string(),
    rulesId: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    message: z.string().min(1),
  }),
]);

export const GameLogKindSchema = z.enum([
  "setup",
  "action",
  "move",
  "turn",
  "round",
  "announce",
  "score",
  "winner",
  "recap",
  "system",
  "error",
]);

export const GameLogEntrySchema = z.object({
  index: z.number().int().nonnegative(),
  turnNumber: z.number().int().nonnegative(),
  kind: GameLogKindSchema,
  message: z.string().min(1),
  timestamp: z.string().datetime().optional(),
  imported: z.boolean().optional(),
  actorId: z.string().nullable().optional(),
  eventType: z.string().optional(),
});

export const GameLogFetchAckSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    gameId: z.string(),
    generatedAt: z.string().datetime(),
    entries: z.array(GameLogEntrySchema),
  }),
  z.object({
    ok: z.literal(false),
    message: z.string().min(1),
  }),
]);

export const AiLogEntrySchema = z.object({
  gameId: z.string(),
  turnNumber: z.number().int(),
  playerId: z.string(),
  phase: z.enum([
    "schedule",
    "candidates",
    "llm",
    "llm-markdown",
    "llm-raw",
    "llm-parsed",
    "fallback",
    "execution",
    "game",
    "error",
  ]),
  level: z.enum(["info", "warn", "error"]),
  message: z.string(),
  source: z.enum(["backend", "frontend"]).optional(),
  details: z.unknown().optional(),
  timestamp: z.string().optional(),
});

export const AiLogFetchAckSchema = z.object({
  gameId: z.string(),
  entries: z.array(AiLogEntrySchema),
  historicalUnavailable: z.boolean().optional(),
});

export type MoveCardsEvent = z.infer<typeof MoveCardsEventSchema>;
export type SetCurrentPlayerEvent = z.infer<typeof SetCurrentPlayerEventSchema>;
export type SetWinnerEvent = z.infer<typeof SetWinnerEventSchema>;
export type SetRulesStateEvent = z.infer<typeof SetRulesStateEventSchema>;
export type SetScoreboardsEvent = z.infer<typeof SetScoreboardsEventSchema>;
export type SetActionsEvent = z.infer<typeof SetActionsEventSchema>;
export type SetPileVisibilityEvent = z.infer<
  typeof SetPileVisibilityEventSchema
>;
export type SetCardVisualsEvent = z.infer<typeof SetCardVisualsEventSchema>;
export type SetPilePropertiesEvent = z.infer<
  typeof SetPilePropertiesEventSchema
>;
export type AnnounceEvent = z.infer<typeof AnnounceEventSchema>;
export type AnnounceKind = z.infer<typeof AnnounceKindSchema>;
export type FatalErrorEvent = z.infer<typeof FatalErrorEventSchema>;
export type GameEvent = z.infer<typeof GameEventSchema>;
export type GameEventPayload = z.infer<typeof GameEventPayloadSchema>;
export type AnnounceEventPayload = z.infer<typeof AnnounceEventPayloadSchema>;
export type PersistedGameEvent = z.infer<typeof PersistedGameEventSchema>;
export type PersistedExecutedIntent = z.infer<
  typeof PersistedExecutedIntentSchema
>;
export type GameSaveOrigin = z.infer<typeof GameSaveOriginSchema>;
export type GameSaveFormat = z.infer<typeof GameSaveFormatSchema>;
export type GameSaveSnapshot = z.infer<typeof GameSaveSnapshotSchema>;
export type GameSaveExportAck = z.infer<typeof GameSaveExportAckSchema>;
export type GameSaveImportAck = z.infer<typeof GameSaveImportAckSchema>;
export type GameLogKind = z.infer<typeof GameLogKindSchema>;
export type GameLogEntry = z.infer<typeof GameLogEntrySchema>;
export type GameLogFetchAck = z.infer<typeof GameLogFetchAckSchema>;
export type AiLogEntryPayload = z.infer<typeof AiLogEntrySchema>;
export type AiLogFetchAck = z.infer<typeof AiLogFetchAckSchema>;
export type EventExecutorRole = NonNullable<
  z.infer<typeof EventBaseSchema.shape.executorRole>
>;

// Base move intent schema
const MoveIntentBaseSchema = z.object({
  type: z.literal("move"),
  gameId: z.string(),
  playerId: z.string(),
  fromPileId: z.string(),
  toPileId: z.string(),
  cardId: CardIdSchema.optional(),
  cardIds: z.array(CardIdSchema).optional(),
  /** Optional target index for reordering within the same pile. */
  targetIndex: z.number().int().nonnegative().optional(),
});

// Helper to enforce the mutual-exclusion and array rules for move intents
function validateMoveIntentShape(
  data: z.infer<typeof MoveIntentBaseSchema>,
  ctx: z.RefinementCtx
): void {
  const hasCardId = data.cardId !== undefined;
  const hasCardIds = data.cardIds !== undefined;

  if (hasCardId === hasCardIds) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Exactly one of 'cardId' or 'cardIds' must be provided",
    });
  }

  if (hasCardIds) {
    const cardIds = data.cardIds ?? [];
    if (cardIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cardIds array cannot be empty",
      });
    }
    const unique = new Set(cardIds);
    if (unique.size !== cardIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cardIds contains duplicate card IDs",
      });
    }
  }
}

// Move intent schema with validation refinements
export const MoveIntentSchema = MoveIntentBaseSchema.superRefine(
  validateMoveIntentShape
);

export const ActionIntentSchema = z.object({
  type: z.literal("action"),
  gameId: z.string(),
  playerId: z.string(),
  action: z.string(), // The action ID (e.g. "1♠", "Pass", "Double")
});

export const ClientIntentSchema = z
  .discriminatedUnion("type", [MoveIntentBaseSchema, ActionIntentSchema])
  .superRefine((data, ctx) => {
    if (data.type !== "move") return;
    validateMoveIntentShape(data, ctx);
  });

export type ClientIntent = z.infer<typeof ClientIntentSchema>;
export type MoveIntent = z.infer<typeof MoveIntentSchema>;

export const LastActionSchema = z.object({
  id: z.string(),
  playerId: z.string(),
  action: z.string(),
  label: z.string().optional(),
  cardId: CardIdSchema.optional(),
  fromPileId: z.string().optional(),
  toPileId: z.string().optional(),
});

export type LastAction = z.infer<typeof LastActionSchema>;

export const CardViewSchema = z.object({
  id: CardViewIdSchema,
  label: z.string().optional(),
  rank: z.string().optional(),
  suit: z.string().optional(),
  faceDown: z.boolean(),
  rotationDeg: z.number().optional(),
});

export type CardView = z.infer<typeof CardViewSchema>;

export const ViewMoveCardsEventPayloadSchema =
  MoveCardsEventPayloadSchema.extend({
    cardIds: z.array(CardViewIdSchema).nonempty(),
    cardViews: z.array(CardViewSchema).optional(),
  });

export const ViewSetCardVisualsEventPayloadSchema =
  SetCardVisualsEventPayloadSchema.extend({
    visuals: z.record(CardIdKeySchema, CardVisualSchema),
  });

export const ViewEventPayloadSchema = z.discriminatedUnion("type", [
  ViewMoveCardsEventPayloadSchema,
  SetCurrentPlayerEventPayloadSchema,
  SetWinnerEventPayloadSchema,
  SetRulesStateEventPayloadSchema,
  SetScoreboardsEventPayloadSchema,
  SetActionsEventPayloadSchema,
  SetPileVisibilityEventPayloadSchema,
  ViewSetCardVisualsEventPayloadSchema,
  AnnounceEventPayloadSchema,
  FatalErrorEventPayloadSchema,
]);

export type ViewEventPayload = z.infer<typeof ViewEventPayloadSchema>;

export const PileViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  ownerId: z.string().nullable().optional(),
  cards: z.array(CardViewSchema),
  totalCards: z.number().int().nonnegative().optional(),
  layout: PileLayoutSchema.optional(),
  allowReorder: z.boolean().optional(),
});

export type PileView = z.infer<typeof PileViewSchema>;

export const AiCandidateSchema = z.object({
  id: z.string(),
  summary: z.string().optional(),
  intent: z.unknown().optional(),
});

export type AiCandidate = z.infer<typeof AiCandidateSchema>;

export const SeatViewSchema = z.object({
  seatId: z.string(),
  name: z.string().optional(),
  ownerLabel: z.string().optional(),
  avatarEmoji: z.string().optional(),
  aiRuntime: AiRuntimeLocationSchema,
  isAiControlledByYou: z.boolean(),
});

export type SeatView = z.infer<typeof SeatViewSchema>;

export const GameViewCoreSchema = z.object({
  gameId: z.string(),
  rulesId: z.string(),
  gameName: z.string(),
  stateVersion: z.number().int().nonnegative().optional(),
  piles: z.array(PileViewSchema),
  winner: z.string().nullable(),
  currentPlayer: z.string().nullable(),
  currentSeatId: z.string().nullable().optional(),
  legalIntents: z.array(ClientIntentSchema).optional(),
  actions: ActionGridSchema, // New unified grid system
  rulesState: z.unknown().optional(),
  scoreboards: z.array(ScoreboardSchema),
  metadata: z.record(z.string(), z.string()).optional(),
  lastEngineEvents: z.array(GameEventPayloadSchema).optional(),
  lastViewEvents: z.array(ViewEventPayloadSchema).optional(),
  lastFatalErrors: z.array(FatalErrorEventPayloadSchema).optional(),
  lastAction: LastActionSchema.optional(),
  seats: z.array(SeatViewSchema).optional(),
  aiCandidatesForCurrentTurn: z.array(AiCandidateSchema).optional(),
});

export const GameViewSchema = GameViewCoreSchema.extend({
  sponsoredAiViews: z.record(GameViewCoreSchema).optional(),
});

export type GameView = z.infer<typeof GameViewSchema>;

export const SeatStatusSchema = z.object({
  playerId: z.string(),
  name: z.string().optional(),
  ownerLabel: z.string().optional(),
  avatarEmoji: z.string().optional(),
  occupied: z.boolean(),
  isAi: z.boolean().optional(),
  aiRuntime: AiRuntimeLocationSchema.optional(),
});

export type SeatStatus = z.infer<typeof SeatStatusSchema>;

export const SeatStatusEventSchema = z.object({
  gameId: z.string(),
  seed: z.string().optional(),
  seats: z.array(SeatStatusSchema),
});

export type SeatStatusEvent = z.infer<typeof SeatStatusEventSchema>;

// Layout schemas
export const GridCellSchema = BaseGridCellSchema;

export type GridCell = z.infer<typeof GridCellSchema>;

export const FloatingWidgetPositionSchema = z.enum([
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "center",
]);

export type FloatingWidgetPosition = z.infer<
  typeof FloatingWidgetPositionSchema
>;

export const FloatingWidgetConfigSchema = z.object({
  widget: z.enum(["actions", "scoreboards"]),
  position: FloatingWidgetPositionSchema,
  defaultOpen: z.boolean().optional(),
});

export type FloatingWidgetConfig = z.infer<typeof FloatingWidgetConfigSchema>;

export const LayoutCardOrderItemSchema = z.object({
  rank: z.string(),
  suit: z.string(),
});

export type LayoutCardOrderItem = z.infer<typeof LayoutCardOrderItemSchema>;

const LayoutPileSortOptionBaseSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  includeFaceDown: z.boolean().optional(),
  applyToLayouts: z.array(PileLayoutSchema).optional(),
});

export type LayoutPileSortOptionBase = z.infer<
  typeof LayoutPileSortOptionBaseSchema
>;

export const LayoutPileSortOptionSchema = z.discriminatedUnion("type", [
  LayoutPileSortOptionBaseSchema.extend({
    type: z.literal("bySuitRank"),
    suitOrder: z.array(z.string()).optional(),
    rankOrder: z.array(z.string()).optional(),
  }),
  LayoutPileSortOptionBaseSchema.extend({
    type: z.literal("byRank"),
    rankOrder: z.array(z.string()).optional(),
    suitOrder: z.array(z.string()).optional(),
  }),
  LayoutPileSortOptionBaseSchema.extend({
    type: z.literal("bySuit"),
    suitOrder: z.array(z.string()).optional(),
    rankOrder: z.array(z.string()).optional(),
  }),
  LayoutPileSortOptionBaseSchema.extend({
    type: z.literal("explicit"),
    order: z.array(LayoutCardOrderItemSchema).nonempty(),
  }),
]);

export type LayoutPileSortOption = z.infer<typeof LayoutPileSortOptionSchema>;

export const LayoutPileSortConfigSchema = z.object({
  default: z.string().optional(),
  options: z.array(LayoutPileSortOptionSchema).nonempty(),
  allowViewerToggle: z.boolean().optional(),
});

export type LayoutPileSortConfig = z.infer<typeof LayoutPileSortConfigSchema>;

export const LayoutZoneSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  cell: GridCellSchema,
  piles: z.array(z.string()),
  handForPlayerId: z.string().optional(),
  widget: z.enum(["actions", "scoreboards", "none"]).optional(),
  actionOrientation: z.enum(["horizontal", "vertical"]).optional(),
  pileOrientation: z.enum(["horizontal", "vertical"]).optional(),
  showLabel: z.boolean().optional(),
  rotation: z
    .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
    .optional(),
  subgrid: z
    .object({
      rows: z.number().int().positive(),
      cols: z.number().int().positive(),
      gap: z.string().optional(),
    })
    .optional(),
  pileGrid: z.record(z.string(), GridCellSchema).optional(),
  floatingWidgets: z.array(FloatingWidgetConfigSchema).optional(),
});

export type LayoutZone = z.infer<typeof LayoutZoneSchema>;

export const LayoutPileStyleSchema = z.object({
  layout: z.string().optional(),
  isHand: z.boolean().optional(),
  className: z.string().optional(),
  label: z.string().optional(),
  hideTitle: z.boolean().optional(),
  showDetails: z.boolean().optional(),
  sort: LayoutPileSortConfigSchema.optional(),
  allowReorder: z.boolean().optional(),
});

export type LayoutPileStyle = z.infer<typeof LayoutPileStyleSchema>;

export const GameLayoutSchema = z.object({
  rulesId: z.string(),
  rows: z.number().int().nonnegative(),
  cols: z.number().int().nonnegative(),
  zones: z.array(LayoutZoneSchema),
  pileStyles: z.record(z.string(), LayoutPileStyleSchema).optional(),
  autoRotate: z.boolean().optional(),
  mobileCompactOpponentHands: z.boolean().optional(),
});

export type GameLayout = z.infer<typeof GameLayoutSchema>;

// ==============================================================================
// AI Support Schemas (New simplified contract)
// ==============================================================================

export const AiViewSchema = z.object({
  seat: z.string(),
  public: z.unknown(),
  private: z.unknown(),
});

export type AiView = z.infer<typeof AiViewSchema>;

export const AiContextSchema = z.object({
  recap: z.array(z.string()).optional(),
  facts: z.record(z.unknown()).optional(),
});

export type AiContext = z.infer<typeof AiContextSchema>;

export const AiCandidateNewSchema = z.object({
  id: z.string().min(1),
  summary: z.string().optional(),
});

export type AiCandidateNew = z.infer<typeof AiCandidateNewSchema>;

export const AiTurnInputSchema = z.object({
  view: AiViewSchema,
  context: AiContextSchema.optional(),
  candidates: z.array(AiCandidateNewSchema),
  rulesMarkdown: z.string(),
});

export type AiTurnInput = z.infer<typeof AiTurnInputSchema>;

export const AiTurnOutputSchema = z
  .object({
    id: z.string().min(1),
    why: z.string().optional(),
  })
  .strict();

export type AiTurnOutput = z.infer<typeof AiTurnOutputSchema>;
