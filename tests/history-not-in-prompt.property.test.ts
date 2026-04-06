import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { PromptComposer } from "../src/core/PromptComposer";
import { createTemplateContext } from "../src/utils/template";
import { EventKind, MessageRole } from "../src/types/history";
import type { Event, MessageEventData } from "../src/types/history";

// --- Arbitraries ---

/** Generate an arbitrary Event object (the format used by addInteractionHistory) */
const participantArb = fc.record({
    display_name: fc.string({ minLength: 1, maxLength: 30 }),
    id: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
});

const messageEventDataArb: fc.Arbitrary<MessageEventData> = fc.record({
    participant: participantArb,
    message: fc.string({ minLength: 1, maxLength: 200 }),
    flagged: fc.option(fc.boolean(), { nil: undefined }),
});

const sourceArb = fc.constantFrom(
    MessageRole.USER,
    MessageRole.ASSISTANT,
    MessageRole.AGENT,
    MessageRole.SYSTEM
);

const eventArb: fc.Arbitrary<Event<MessageEventData>> = fc.record({
    kind: fc.constant(EventKind.MESSAGE),
    source: sourceArb,
    data: messageEventDataArb,
    timestamp: fc.option(
        fc.integer({ min: 1577836800000, max: 1893456000000 }).map((ms) => new Date(ms).toISOString()),
        { nil: undefined }
    ),
    id: fc.option(fc.uuid(), { nil: undefined }),
});

const historyArb = fc.array(eventArb, { minLength: 1, maxLength: 15 });

/** Arbitrary directives list */
const directivesArb = fc.array(fc.string({ minLength: 1, maxLength: 50 }), {
    minLength: 0,
    maxLength: 5,
});

/** Arbitrary knowledge base */
const knowledgeBaseArb = fc.dictionary(
    fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
    fc.string({ minLength: 1, maxLength: 50 }),
    { minKeys: 0, maxKeys: 3 }
);

// --- Property 16: History Not In System Prompt ---

describe("Property 16: History Not In System Prompt", () => {
    /**
     * **Validates: Requirements 17.1, 17.2**
     *
     * For any prompt built by the updated PromptComposer.build(),
     * the result does not contain serialized interaction history or
     * "## Interaction History" or "## Last Message" sections.
     */

    test("prompt built without addInteractionHistory/addLastMessage does not contain history markers", async () => {
        await fc.assert(
            fc.asyncProperty(
                historyArb,
                directivesArb,
                knowledgeBaseArb,
                async (history, directives, knowledgeBase) => {
                    const templateContext = createTemplateContext({ history });
                    const pc = new PromptComposer(templateContext);

                    // Call the same methods ResponseEngine.buildResponsePrompt() calls
                    // but NOT addInteractionHistory or addLastMessage
                    await pc.addAgentMeta({
                        name: "TestAgent",
                        identity: "A test agent",
                        personality: "Friendly",
                    });
                    await pc.addInstruction("Route: TestRoute — A test route");
                    await pc.addDirectives(directives.length > 0 ? directives : undefined);
                    await pc.addKnowledgeBase(
                        Object.keys(knowledgeBase).length > 0 ? knowledgeBase : undefined
                    );
                    await pc.addGlossary([]);
                    await pc.addGuidelines([]);

                    const prompt = await pc.build();

                    // The prompt must NOT contain history section headers
                    expect(prompt).not.toContain("## Interaction History");
                    expect(prompt).not.toContain("## Last Message");

                    // The prompt must NOT contain JSON-serialized event strings
                    for (const event of history) {
                        expect(prompt).not.toContain(JSON.stringify(event));
                    }
                }
            ),
            { numRuns: 50 }
        );
    });

    test("deprecated addInteractionHistory() still produces history section when called directly (backward compat)", async () => {
        await fc.assert(
            fc.asyncProperty(historyArb, async (history) => {
                const templateContext = createTemplateContext({ history });
                const pc = new PromptComposer(templateContext);

                await pc.addAgentMeta({ name: "TestAgent" });
                // Explicitly call the deprecated method
                await pc.addInteractionHistory(history);

                const prompt = await pc.build();

                // When addInteractionHistory IS called, the section SHOULD appear
                expect(prompt).toContain("## Interaction History");
                expect(prompt).toContain("Recent conversation events:");
            }),
            { numRuns: 30 }
        );
    });

    test("deprecated addLastMessage() still produces last message section when called directly (backward compat)", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.stringMatching(/^[a-zA-Z0-9]{3,100}$/),
                async (message) => {
                    const templateContext = createTemplateContext({});
                    const pc = new PromptComposer(templateContext);

                    await pc.addAgentMeta({ name: "TestAgent" });
                    // Explicitly call the deprecated method
                    await pc.addLastMessage(message);

                    const prompt = await pc.build();

                    // When addLastMessage IS called, the section SHOULD appear
                    expect(prompt).toContain("## Last Message");
                    expect(prompt).toContain(message);
                }
            ),
            { numRuns: 30 }
        );
    });

    test("prompt with all standard sections but no history calls remains clean of history content", async () => {
        await fc.assert(
            fc.asyncProperty(
                historyArb,
                knowledgeBaseArb,
                async (history, knowledgeBase) => {
                    const templateContext = createTemplateContext({ history });
                    const pc = new PromptComposer(templateContext);

                    // Build a full prompt like ResponseEngine does
                    await pc.addAgentMeta({
                        name: "FullAgent",
                        identity: "A comprehensive agent",
                        personality: "Professional",
                        goal: "Help users",
                        description: "An agent for testing",
                        rules: ["Be helpful"],
                        prohibitions: ["Never lie"],
                    });
                    await pc.addInstruction("Route: Main — Primary route");
                    await pc.addInstruction("Rules:\n- Follow instructions");
                    await pc.addDirectives(["Address the user's question"]);
                    await pc.addKnowledgeBase(
                        Object.keys(knowledgeBase).length > 0 ? knowledgeBase : undefined
                    );
                    await pc.addGlossary([
                        { name: "API", description: "Application Programming Interface" },
                    ]);

                    const prompt = await pc.build();

                    // Verify standard sections ARE present
                    expect(prompt).toContain("## Agent Identity");
                    expect(prompt).toContain("## Instruction");
                    expect(prompt).toContain("## Directives");
                    expect(prompt).toContain("## Glossary");

                    // Verify history sections are NOT present
                    expect(prompt).not.toContain("## Interaction History");
                    expect(prompt).not.toContain("## Last Message");

                    // No serialized events leaked into the prompt
                    for (const event of history) {
                        expect(prompt).not.toContain(JSON.stringify(event));
                    }
                }
            ),
            { numRuns: 50 }
        );
    });
});
