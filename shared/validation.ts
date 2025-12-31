import { z } from "zod";
import { GameEventPayloadSchema } from "./schemas.js";

export const ValidationResultSchema = z.object({
  valid: z.boolean(),
  reason: z.string().nullable().optional(),
  engineEvents: z.array(GameEventPayloadSchema).default([]),
});

export type EngineEvent = z.infer<typeof GameEventPayloadSchema>;
export type ValidationResult = z.infer<typeof ValidationResultSchema>;
