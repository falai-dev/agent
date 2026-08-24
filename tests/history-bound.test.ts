/**
 * History bound — session.history is capped by default (maxHistoryMessages,
 * default 400) so long-running chat()/stream() threads cannot grow until the
 * provider context limit bricks them. Trimming never splits an assistant/tool
 * pair at the left edge.
 */
import { describe, expect, test } from "bun:test";

import {
    boundConversationHistory,
    DEFAULT_MAX_HISTORY_MESSAGES,
} from "../src/utils/session";
import { assistantMessage, toolMessage, userMessage } from "../src/utils/history";
import type { HistoryItem } from "../src/types/history";

function makeHistory(n: number): HistoryItem[] {
    return Array.from({ length: n }, (_, i) =>
        i % 2 === 0 ? userMessage(`u${i}`) : assistantMessage(`a${i}`)
    );
}

describe("boundConversationHistory", () => {
    test("returns the same reference when under the bound", () => {
        const h = makeHistory(10);
        expect(boundConversationHistory(h, 400)).toBe(h);
    });

    test("trims to the most recent entries", () => {
        const bounded = boundConversationHistory(makeHistory(500), 100);
        expect(bounded.length).toBe(100);
        expect((bounded.at(-1) as { content: string }).content).toBe("a499");
    });

    test("never opens on an orphaned role:'tool' message", () => {
        // [u, a(tool_calls), t, ... x500] with a cut landing between the pair.
        const history: HistoryItem[] = [userMessage("seed")];
        for (let i = 0; i < 300; i++) {
            history.push(
                assistantMessage(null, [{ id: `c${i}`, name: "t", arguments: {} }]),
                toolMessage("t", `c${i}`, "ok"),
            );
        }
        const bounded = boundConversationHistory(history, 5);
        expect(bounded.length).toBeLessThanOrEqual(7); // cap + pair-extension slack
        expect(bounded[0]?.role).not.toBe("tool");
    });
});

describe("default configuration bounds history", () => {
    test("DEFAULT_MAX_HISTORY_MESSAGES is finite and generous", () => {
        expect(DEFAULT_MAX_HISTORY_MESSAGES).toBeGreaterThanOrEqual(100);
        expect(Number.isFinite(DEFAULT_MAX_HISTORY_MESSAGES)).toBe(true);
    });
});
