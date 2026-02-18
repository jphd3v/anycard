export const INVALID_EMAIL_MESSAGE = "Please enter a valid email address";
export const INVALID_API_KEY_MESSAGE = "Invalid API key";
export const MAGIC_LINK_SENT_PREFIX = "Email sent to ";

export function formatMagicLinkSentMessage(email: string): string {
  return `${MAGIC_LINK_SENT_PREFIX}${email} for signing in.`;
}
