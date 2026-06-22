/**
 * The user-facing text of a (possibly structured) model completion, trimmed.
 *
 * Under a JSON schema the real message lives in `structured.message`; otherwise
 * it's the raw/accumulated text passed as `fallbackText`. A blank result with no
 * tool calls means the model produced nothing usable — providers throw on that
 * so the retry/backup path runs instead of emitting an empty message. Shared by
 * the streaming and non-streaming empty-completion guards across all providers.
 */
export function effectiveMessageText(
  structured: unknown,
  fallbackText: string
): string {
  const message =
    typeof structured === "object" && structured !== null && "message" in structured
      ? structured.message
      : undefined;
  return (typeof message === "string" ? message : fallbackText).trim();
}
