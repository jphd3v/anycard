// shared/src/ai/parser.ts
import type { AiChoice } from "./types.js";

export function parseAiChoice(raw: string): AiChoice | null {
  const text = String(raw ?? "");
  if (!text.trim()) return null;

  // 1. Try to find content within <final_json> tags (highest priority)
  const tagMatch = text.match(/<final_json>([\s\S]*?)<\/final_json>/i);
  if (tagMatch) {
    const json = tagMatch[1].trim();
    const result = parseFirstValidObject(json);
    if (result) return result;
  }

  // 2. Fallback to searching the entire response for valid JSON objects.
  // We prioritize the last valid object in the text as some models might
  // output multiple blocks or repeat themselves.
  const allObjects = Array.from(extractJsonObjects(text));
  for (let i = allObjects.length - 1; i >= 0; i--) {
    const result = parseFirstValidObject(allObjects[i]);
    if (result) return result;
  }

  return null;
}

function parseFirstValidObject(json: string): AiChoice | null {
  try {
    // If the string contains multiple objects, extractJsonObjects handles it,
    // but here we just try to parse the whole string first.
    const obj = JSON.parse(json) as { chosenCandidateId?: unknown };
    if (typeof obj.chosenCandidateId === "string") {
      const chosenCandidateId = obj.chosenCandidateId.trim();
      if (chosenCandidateId) return { chosenCandidateId };
    }
  } catch {
    // String might have multiple objects or extra text; try deep extraction
    for (const subJson of extractJsonObjects(json)) {
      try {
        const obj = JSON.parse(subJson) as { chosenCandidateId?: unknown };
        if (typeof obj.chosenCandidateId === "string") {
          const chosenCandidateId = obj.chosenCandidateId.trim();
          if (chosenCandidateId) return { chosenCandidateId };
        }
      } catch {
        continue;
      }
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
