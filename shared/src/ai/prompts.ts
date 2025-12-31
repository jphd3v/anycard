// shared/src/ai/prompts.ts
import type { AiRequest } from "./types.js";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

// Builds OpenAI-style messages; both backend and frontend use this.
export function buildAiMessages(req: AiRequest): ChatMessage[] {
  const { rulesId, seatId, view, candidates, agentGuide } = req;

  const systemContent = [
    `You are an AI playing a card game with rulesId="${rulesId}".`,
    `You control seat "${seatId}".`,
    `You must choose exactly one candidate move by its "id".`,
    `Use the provided rulesMarkdown (if present) to understand the game.`,
    `Only use the rulesMarkdown, the view, and the candidate list provided.`,
    `Do NOT rely on any outside knowledge about the game.`,
    `Assume the view is the only information you can see; do not infer hidden cards.`,
    `Do NOT invent new moves or candidate ids.`,
    `Candidate ids are semantic.`,
    `Cards are uniquely identified by "id". The same rank+suit may appear multiple times in multi-deck games; do not treat duplicates as an error.`,
    `If "agentGuide" is present, treat it as authoritative for legality, phase, and constraints. Do not infer legality solely from candidate availability.`,
    `You should reason about your choice before making it to ensure it is legal and strategic.`,
    `Return your final choice in a single JSON object wrapped in <final_json> tags. Any text outside <final_json> will be ignored.`,
    `Example: <final_json>{"chosenCandidateId": "move:P1-hand:cardId_123->discard"}</final_json>`,
    `If scoreboards include "WE/THEY" labels, they may be perspective-based; do not infer teams from those labels.`,
    `Piles only list visible cards; if hiddenCount > 0, that many cards are hidden.`,
    `General play heuristics (only if consistent with the rules/state):`,
    `If the game does not involve trick play, ignore trick-play heuristics.`,
    `Avoid wasting high cards on a trick you cannot win; if a trick is already won by another player, prefer the lowest legal card.`,
  ].join("\n");

  const rulesMarkdown = req.rulesMarkdown?.trim() ?? "";
  const candidatesPayload = JSON.stringify(
    candidates.map((c: AiRequest["candidates"][number]) => ({ id: c.id }))
  );

  const agentGuideBlock = agentGuide
    ? [
        "<agentGuide>",
        JSON.stringify(agentGuide, null, 2),
        "</agentGuide>",
      ].join("\n")
    : "";

  const instruction =
    `1. Reason about the current state and legal constraints.\n` +
    `2. Select the best candidate id.\n` +
    `3. End your response with: <final_json>{"chosenCandidateId": "<id>"}</final_json>`;

  const userContent = [
    "<rulesMarkdown>",
    rulesMarkdown || "(none)",
    "</rulesMarkdown>",
    agentGuideBlock,
    "<view>",
    JSON.stringify(view),
    "</view>",
    "<candidates>",
    candidatesPayload,
    "</candidates>",
    "<instruction>",
    instruction,
    "</instruction>",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];
}
