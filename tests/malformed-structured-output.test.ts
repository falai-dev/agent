/**
 * Malformed structured output — a schema-mandated response the provider could
 * not parse must NEVER surface raw protocol fragments (`{"message": "Sure, I
 * can boo…`) as the user-visible reply. JSON-shaped fragments are salvage-
 * parsed; unrecoverable fragments fail the turn (rollback engages) instead.
 */
import { describe, expect, test } from "bun:test";

import { Agent } from "../src/core/Agent.js";
import { MockProvider } from "./mock-provider.js";
import type {
    AiProvider,
    GenerateMessageInput,
    GenerateMessageOutput,
} from "../src/types/ai.js";

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
            agent.respond({
                history: [{ role: "user", content: "hi" }],
            })
        ).rejects.toThrow(/could not be parsed as JSON/);
    });

    test("fence-wrapped valid JSON is salvaged into a clean reply", async () => {
        const agent = makeAgent('```json\n{"message": "Clean reply."}\n```');
        const response = await agent.respond({
            history: [{ role: "user", content: "hi" }],
        });
        expect(response.message).toBe("Clean reply.");
    });

    test("plain prose without any JSON shape still passes through untouched", async () => {
        const agent = makeAgent("Just a plain sentence from the model.");
        const response = await agent.respond({
            history: [{ role: "user", content: "hi" }],
        });
        expect(response.message).toBe("Just a plain sentence from the model.");
    });

    test("prose followed by the protocol envelope unwraps to the envelope's reply", async () => {
        // The observed WhatsApp leak: the model wrote the conversational reply,
        // then emitted the protocol envelope repeating it. The raw turn is
        // neither plain prose nor pure JSON, so neither the parse nor the
        // JSON-shape gate caught it — only the embedded extraction does.
        const raw =
            'Boa noite Danilo! Perfeito, pesquisa é sempre bem-vinda 😄\nSe quiser, te mando os valores.' +
            '{"message":"Boa noite Danilo! Perfeito, pesquisa é sempre bem-vinda 😄\\nSe quiser, te mando os valores.","intencao":"pesquisa de preços / comparação"}';
        const agent = makeAgent(raw);
        const response = await agent.respond({
            history: [{ role: "user", content: "pesquisada" }],
        });
        expect(response.message).toBe(
            "Boa noite Danilo! Perfeito, pesquisa é sempre bem-vinda 😄\nSe quiser, te mando os valores."
        );
        expect(response.message).not.toContain("{");
    });

    test("prose that merely contains braces passes through untouched", async () => {
        const agent = makeAgent("Use {chaves} com cuidado.");
        const response = await agent.respond({
            history: [{ role: "user", content: "hi" }],
        });
        expect(response.message).toBe("Use {chaves} com cuidado.");
    });


    test("a pretty-printed envelope with raw newlines is repaired, not sent", async () => {
        // The bytes a WhatsApp customer received on 2026-09-11. The model was
        // ASKED for the envelope in its prompt (the only way a schema can ride
        // on a call that also carries tools), so nothing pinned its decoder and
        // it pretty-printed the reply: literal newlines inside the message
        // string, which `JSON.parse` calls an unterminated string.
        const raw = [
            "{",
            '"message": "Boa escolha, Matheus! 😄',
            "IPHONE 14 PRO 128GB",
            "• À vista: R$ 3.149 no Pix ou cartão",
            'Qual cor prefere?",',
            '"item": "iPhone 14 Pro 128GB"',
            "}",
        ].join("\n");

        const agent = makeAgent(raw);
        const response = await agent.respond({
            history: [{ role: "user", content: "Pode ser o 14 Pro" }],
        });

        expect(response.message).toBe(
            "Boa escolha, Matheus! 😄\nIPHONE 14 PRO 128GB\n• À vista: R$ 3.149 no Pix ou cartão\nQual cor prefere?"
        );
        expect(response.message).not.toContain('"message"');
        // Repairing the envelope beats reading the message out of it: the turn
        // keeps the field it collected.
        expect(response.session?.data?.item).toBe("iPhone 14 Pro 128GB");
    });
});

/**
 * The tool loop calls the model again with the SAME response schema, and that
 * message replaces the one the pre-tool guard already cleared — so the leak
 * has a second door. This is the shape that actually reached the customer: the
 * catalog tool answered, then the closing call returned the envelope raw.
 */
describe("malformed output from the post-tool call", () => {
    function leakingFollowUpProvider(followUpMessage: string): MockProvider {
        const provider = new MockProvider();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (provider as any).generateMessage = async (input: any) => {
            const schema = input.parameters?.jsonSchema as any;
            const schemaName = (input.parameters?.schemaName as string) || "";
            const meta = { model: "mock", tokensUsed: 10, finishReason: "stop" };

            if (schema?.properties?.flows?.properties) {
                const flows: Record<string, number> = {};
                Object.keys(schema.properties.flows.properties).forEach((id) => (flows[id] = 80));
                return { message: "Routing", metadata: meta, structured: { context: "t", flows, responseDirectives: [] } };
            }
            if (schema?.properties?.selectedStepId) {
                const stepIds = schema.properties.selectedStepId?.enum || [];
                return { message: "Step", metadata: meta, structured: { reasoning: "t", selectedStepId: stepIds[0] } };
            }
            // First call: ask for the catalog.
            if (schemaName === "response_output") {
                return {
                    message: "Deixa eu ver aqui.",
                    metadata: meta,
                    structured: { message: "Deixa eu ver aqui.", toolCalls: [{ toolName: "catalog", arguments: {} }] },
                };
            }
            // Closing call: the provider could not parse it, so `structured` is
            // absent and the raw text is all the caller gets.
            if (schemaName === "tool_followup" || schemaName === "tool_final_text") {
                return { message: followUpMessage, metadata: meta };
            }
            return { message: "", metadata: meta, structured: {} };
        };
        return provider;
    }

    function makeToolAgent(followUpMessage: string) {
        const agent = new Agent<TestContext, TestData>({
            name: "toolSalvageAgent",
            sessionId: "sess_tool_salvage",
            provider: leakingFollowUpProvider(followUpMessage),
            flows: [{ id: "flowA", title: "A", steps: [{ id: "ask", prompt: "ask" }] }],
        });
        agent.addTool({ id: "catalog", description: "Catalog", handler: async () => ({ price: 3149 }) });
        return agent;
    }

    test("a repairable envelope after the tools ran is cleaned, not sent raw", async () => {
        const agent = makeToolAgent('{\n"message": "À vista: R$ 3.149.\nQual cor prefere?"\n}');

        const response = await agent.respond({ history: [{ role: "user", content: "Pode ser o 14 Pro" }] });

        expect(response.message).toBe("À vista: R$ 3.149.\nQual cor prefere?");
        expect(response.message).not.toContain('"message"');
    });

    test("an unrecoverable envelope after the tools ran fails the turn", async () => {
        const agent = makeToolAgent('{"message": "R$ 3.149, sem o fechamento');

        await expect(
            agent.respond({ history: [{ role: "user", content: "Pode ser o 14 Pro" }] })
        ).rejects.toThrow(/could not be parsed as JSON/);
    });

    test("a plain-text closing message still passes through", async () => {
        const agent = makeToolAgent("À vista sai R$ 3.149.");

        const response = await agent.respond({ history: [{ role: "user", content: "Pode ser o 14 Pro" }] });

        expect(response.message).toBe("À vista sai R$ 3.149.");
    });
});
