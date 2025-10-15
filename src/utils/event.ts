import { type Event, EventKind } from "../types/history";
/**
 * Helper to extract last message from history
 */
export function getLastMessageFromHistory(history: Event[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const event = history[i];
    if (event.kind === EventKind.MESSAGE) {
      if (!event.data || !("message" in event.data)) {
        continue;
      }
      return event.data.message;
    }
  }
  return "";
}
