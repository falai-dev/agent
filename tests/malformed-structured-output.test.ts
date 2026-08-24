/**
 * Malformed structured output — a schema-mandated response the provider could
 * not parse must NEVER surface raw protocol fragments (`{"message": "Sure, I
 * can boo…`) as the user-visible reply. JSON-shaped fragments are salvage-
 * parsed; unrecoverable fragments fail the turn (rollback engages) instead.
 */
import { describe, expect, test } from "bun:test";

import { Agent } from "../src/core/Agent";
import type {
    AiProvider,
    GenerateMessageInput,
    GenerateMessageOutput,
} from "../src/types/ai";

interface TestContext { userId: string }
interface TestData { item?: string }

function stubProvider(message: string): AiProvider {
    return {
        name: "stub",
        capabilities: {
            supportsTools: true,
            supportsNativeJsonSchema: true,
            supportsStreaming: true,
            supportsStreamingToolCalls: false,
            supportsPromptCaching: false,
        },
        generateMessage: async (_input: GenerateMessageInput<unknown>) =>
            ({ message, metadata: {} }) as GenerateMessageOutput,
        // eslint-disable-next-line require-yield
        generateMessageStream: async function* () {
            throw new Error("streaming not exercised in this test");
        },
    } as unknown as AiProvider;
}

function makeAgent(message: string) {
    return new Agent<TestContext, TestData>({
        name: "salvageAgent",
        sessionId: "sess_salvage",
        provider: stubProvider(message),
        flows: [
            {
                id: "flowA",
                title: "A",
                requiredFields: ["item"],
                steps: [{ id: "ask", prompt: "ask" }],
            },
        ],
    });
}

describe("malformed schema-mandated output", () => {
    test("truncated JSON fragment fails the turn instead of leaking to the user", async () => {
        const agent = makeAgent('{"message": "Sure, I can boo');
        await expect(
            agent.respond<TestContext, TestData>({
                history: [{ role: "user", content: "hi" }],
            })
        ).rejects.toThrow(/could not be parsed as JSON/);
    });

    test("fence-wrapped valid JSON is salvaged into a clean reply", async () => {
        const agent = makeAgent('```json\n{"message": "Clean reply."}\n```');
        const response = await agent.respond<TestContext, TestData>({
            history: [{ role: "user", content: "hi" }],
        });
        expect(response.message).toBe("Clean reply.");
    });

    test("plain prose without any JSON shape still passes through untouched", async () => {
        const agent = makeAgent("Just a plain sentence from the model.");
        const response = await agent.respond<TestContext, TestData>({
            history: [{ role: "user", content: "hi" }],
        });
        expect(response.message).toBe("Just a plain sentence from the model.");
    });
});
