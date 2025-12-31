export type SystemFallbackContext = {
  errorMessage?: string;
  status?: number;
  baseUrl?: string;
  modelId?: string;
};

export function isSystemUnsupportedError(
  context: SystemFallbackContext
): boolean {
  const message = (context.errorMessage ?? "").toLowerCase();
  if (
    message.includes("developer instruction") ||
    message.includes("developer_instruction")
  ) {
    return true;
  }

  const status = context.status;
  const baseUrl = context.baseUrl ?? "";
  const modelId = context.modelId ?? "";

  if (
    status === 400 &&
    (baseUrl.includes("generativelanguage.googleapis.com") ||
      modelId.toLowerCase().includes("gemma"))
  ) {
    return true;
  }

  return false;
}

export function mergeSystemIntoUser(
  systemPrompt: string,
  userContent: string
): string {
  return [
    "System instructions (treat as high priority):",
    systemPrompt,
    "",
    "User input:",
    userContent,
  ].join("\n");
}
