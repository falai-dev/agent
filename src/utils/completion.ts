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

/**
 * The single definition of "the model produced nothing usable": a blank
 * effective message ({@link effectiveMessageText}) and no tool calls. When that
 * holds, throw `No response from <provider>` so the caller's retry/backup path
 * runs instead of surfacing an empty turn. Lifting this above the providers
 * keeps the streaming and non-streaming guards — six call sites across three
 * providers — from drifting on what counts as empty.
 */
export function assertUsableCompletion(
  structured: unknown,
  fallbackText: string,
  toolCallCount: number,
  providerLabel: string
): void {
  if (toolCallCount === 0 && !effectiveMessageText(structured, fallbackText)) {
    throw new Error(`No response from ${providerLabel}`);
  }
}
