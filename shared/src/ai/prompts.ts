// shared/src/ai/prompts.ts
import type { AiTurnInput } from "./types.js";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/**
 * Build OpenAI-style messages for the simplified AI contract.
 * Input: view (seat-hardened), context (recap + facts), candidates (ids only).
 * Output: JSON with single "id" field.
 *
 * Structure:
 * - System prompt: Instructions + Game rules (stable, can be cached by providers)
 * - User prompt: Current state + candidates (changes each turn)
 */
export function buildAiMessages(input: AiTurnInput): ChatMessage[] {
  const { view, context, candidates, rulesMarkdown } = input;

  // System prompt: instructions + rules (sent once, cacheable)
  const systemParts = [
    `You are an AI playing a card game. Choose exactly one move by its id.`,
    `All listed moves are legal. Pick the best one based on strategy.`,
    `You may think through your reasoning, but your final answer MUST be inside <answer> tags.`,
    `Format: <answer>{"id": "cX"}</answer>`,
  ];

  // Add rules to system prompt (stable content, good for caching)
  if (rulesMarkdown) {
    systemParts.push("");
    systemParts.push("# Game Rules");
    systemParts.push("");
    systemParts.push(sanitizeRulesMarkdown(rulesMarkdown));
  }

  const systemContent = systemParts.join("\n");

  // Format candidates as readable markdown list
  const candidatesPayload = candidates
    .map((c, idx) => {
      const num = String(idx + 1).padStart(2, " ");
      return `${num}. ${c.id} — ${c.summary ?? "(no description)"}`;
    })
    .join("\n");

  // User prompt: dynamic state (changes each turn)
  const userSections = [];

  // Game state (compact JSON)
  userSections.push(`# Current State\n\n${JSON.stringify(view, null, 2)}\n`);

  // Context (recap + facts) if present
  if (context) {
    const contextParts = [];
    if (context.recap && context.recap.length > 0) {
      contextParts.push(`<recap>\n${context.recap.join("\n")}\n</recap>`);
    }
    if (context.facts && Object.keys(context.facts).length > 0) {
      contextParts.push(
        `<facts>\n${JSON.stringify(context.facts, null, 2)}\n</facts>`
      );
    }
    if (contextParts.length > 0) {
      userSections.push(`# Context\n\n${contextParts.join("\n")}\n`);
    }
  }

  // Available moves
  userSections.push(
    `# Available Moves\n\nChoose one:\n\n${candidatesPayload}\n`
  );

  // Brief reminder of output format
  userSections.push(`Reply with: <answer>{"id": "cX"}</answer>`);

  const userContent = userSections.join("\n");

  return [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];
}

function sanitizeRulesMarkdown(markdown: string): string {
  if (!markdown) return markdown;
  return stripStrategySections(markdown).trim();
}

function stripStrategySections(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  let skipLevel = 0;
  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim().toLowerCase();
      if (skipping && level <= skipLevel) {
        skipping = false;
      }
      if (!skipping && (title === "strategy" || title === "game strategy")) {
        skipping = true;
        skipLevel = level;
        continue;
      }
    }
    if (!skipping) {
      out.push(line);
    }
  }
  return out.join("\n");
}
