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
  role: z.enum(["header", "body", "total"]).optional(),
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

export const GameStateSchema = z.object({
  gameId: z.string(),
  rulesId: z.string(),
  gameName: z.string(),
  seed: z.string().optional(),
  cards: z.record(CardIdKeySchema, CardSchema),
  cardVisuals: z.record(CardIdKeySchema, CardVisualSchema).optional(),
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
});

export const MoveCardsEventSchema = EventBaseSchema.extend({
  type: z.literal("move-cards"),
  fromPileId: z.string(),
  toPileId: z.string(),
  cardIds: z.array(CardIdSchema).nonempty(),
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
  FatalErrorEventSchema,
]);

const MoveCardsEventPayloadSchema = MoveCardsEventSchema.omit({
  id: true,
  gameId: true,
  playerId: true,
});
const SetCurrentPlayerEventPayloadSchema = SetCurrentPlayerEventSchema.omit({
  id: true,
  gameId: true,
  playerId: true,
});
const SetWinnerEventPayloadSchema = SetWinnerEventSchema.omit({
  id: true,
  gameId: true,
  playerId: true,
});
const SetRulesStateEventPayloadSchema = SetRulesStateEventSchema.omit({
  id: true,
  gameId: true,
  playerId: true,
});
const SetScoreboardsEventPayloadSchema = SetScoreboardsEventSchema.omit({
  id: true,
  gameId: true,
  playerId: true,
});
const SetActionsEventPayloadSchema = SetActionsEventSchema.omit({
  id: true,
  gameId: true,
  playerId: true,
});

const SetPileVisibilityEventPayloadSchema = SetPileVisibilityEventSchema.omit({
  id: true,
  gameId: true,
  playerId: true,
});

const SetCardVisualsEventPayloadSchema = SetCardVisualsEventSchema.omit({
  id: true,
  gameId: true,
  playerId: true,
});

const FatalErrorEventPayloadSchema = FatalErrorEventSchema.omit({
  id: true,
  gameId: true,
  playerId: true,
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
  FatalErrorEventPayloadSchema,
]);

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
export type FatalErrorEvent = z.infer<typeof FatalErrorEventSchema>;
export type GameEvent = z.infer<typeof GameEventSchema>;
export type GameEventPayload = z.infer<typeof GameEventPayloadSchema>;

export const MoveIntentSchema = z.object({
  type: z.literal("move"),
  gameId: z.string(),
  playerId: z.string(),
  fromPileId: z.string(),
  toPileId: z.string(),
  cardId: CardIdSchema,
});

export const ActionIntentSchema = z.object({
  type: z.literal("action"),
  gameId: z.string(),
  playerId: z.string(),
  action: z.string(), // The action ID (e.g. "1♠", "Pass", "Double")
});

export const ClientIntentSchema = z.discriminatedUnion("type", [
  MoveIntentSchema,
  ActionIntentSchema,
]);

export type ClientIntent = z.infer<typeof ClientIntentSchema>;

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
});

export type PileView = z.infer<typeof PileViewSchema>;

export const AiCandidateSchema = z.object({
  id: z.string(),
  summary: z.string(),
  intent: z.unknown(),
});

export type AiCandidate = z.infer<typeof AiCandidateSchema>;

export const SeatViewSchema = z.object({
  seatId: z.string(),
  name: z.string().optional(),
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
  widget: z.enum(["actions", "scoreboards", "none"]).optional(),
  actionOrientation: z.enum(["horizontal", "vertical"]).optional(),
  floatingWidgets: z.array(FloatingWidgetConfigSchema).optional(),
});

export type LayoutZone = z.infer<typeof LayoutZoneSchema>;

export const LayoutPileStyleSchema = z.object({
  layout: z.string().optional(),
  className: z.string().optional(),
  label: z.string().optional(),
  showDetails: z.boolean().optional(),
  sort: LayoutPileSortConfigSchema.optional(),
});

export type LayoutPileStyle = z.infer<typeof LayoutPileStyleSchema>;

export const GameLayoutSchema = z.object({
  rulesId: z.string(),
  rows: z.number().int().nonnegative(),
  cols: z.number().int().nonnegative(),
  zones: z.array(LayoutZoneSchema),
  pileStyles: z.record(z.string(), LayoutPileStyleSchema).optional(),
});

export type GameLayout = z.infer<typeof GameLayoutSchema>;
