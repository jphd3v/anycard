// shared/src/ai/parser.ts
import type { AiTurnOutput } from "./types.js";
import { AiTurnOutputSchema } from "../../schemas.js";

/**
 * Parse the simplified AI response format.
 * Expected: <answer>{"id": "<candidate id>"}</answer>
 * Fallback: {"id": "<candidate id>"} anywhere in the response
 * Optional: {"id": "<candidate id>", "why": "<reasoning>"}
 */
export function parseAiOutput(raw: string): AiTurnOutput | null {
  const text = String(raw ?? "");
  if (!text.trim()) return null;

  // First try to extract JSON from within <answer> tags (more robust)
  const answerMatch = text.match(/<answer>([\s\S]*?)<\/answer>/);
  if (answerMatch) {
    const answerContent = answerMatch[1].trim();
    try {
      const obj = JSON.parse(answerContent) as { id?: unknown };
      const parsed = AiTurnOutputSchema.safeParse({ id: obj.id });
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      // Fall through to general JSON extraction
    }
  }

  // Fallback: Try to extract JSON objects from anywhere in the response
  const allObjects = Array.from(extractJsonObjects(text));

  // Check all objects, prioritizing the last valid one
  for (let i = allObjects.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(allObjects[i]) as { id?: unknown };

      // Validate using Zod schema
      const parsed = AiTurnOutputSchema.safeParse({ id: obj.id });
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function* extractJsonObjects(text: string): Generator<string> {
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start === -1) return;

    const end = findMatchingBrace(text, start);
    if (end === -1) {
      // No balanced object from this "{", continue searching.
      i = start + 1;
      continue;
    }

    yield text.slice(start, end + 1);
    i = end + 1;
  }
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth++;
      continue;
    }

    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}
