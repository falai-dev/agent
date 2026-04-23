/**
 * Tests for provider history handling
 *
 * Validates that each provider correctly builds multi-turn messages
 * from HistoryItem[] format, including:
 * - Empty history (single user message with prompt)
 * - User/assistant message mapping
 * - Tool messages mapped per provider format
 * - System messages handled per provider convention
 * - Assistant messages with tool_calls
 *
 * Validates: Requirements 17.2, 17.3
 */

import { describe, test, expect } from "bun:test";
import type { HistoryItem } from "../src/types/history";

// ============================================================================
// Test helpers: extract the private buildXxxMessages methods via subclassing
// ============================================================================

// We test the message-building logic by importing the providers and
// calling generateMessage with a mock that captures the params.

// --- Anthropic ---
import { AnthropicProvider } from "../src/providers/AnthropicProvider";

// --- OpenAI ---
import { OpenAIProvider } from "../src/providers/OpenAIProvider";

// --- Gemini ---
import { GeminiProvider } from "../src/providers/GeminiProvider";

// --- OpenRouter ---
import { OpenRouterProvider } from "../src/providers/OpenRouterProvider";

// Since the build methods are private, we test them indirectly by creating
// testable subclasses that expose the private methods.

class TestableAnthropicProvider extends AnthropicProvider {
    // @ts-expect-error - accessing private method for testing
    public testBuildMessages(history: HistoryItem[]) {
        // @ts-expect-error - accessing private method for testing
        return this.buildAnthropicMessages(history);
    }
}

class TestableOpenAIProvider extends OpenAIProvider {
    // @ts-expect-error - accessing private method for testing
    public testBuildMessages(history: HistoryItem[]) {
        // @ts-expect-error - accessing private method for testing
        return this.buildOpenAIMessages(history);
    }
}

class TestableGeminiProvider extends GeminiProvider {
    // @ts-expect-error - accessing private method for testing
    public testBuildContents(history: HistoryItem[]) {
        // @ts-expect-error - accessing private method for testing
        return this.buildGeminiContents(history);
    }
}

class TestableOpenRouterProvider extends OpenRouterProvider {
    // @ts-expect-error - accessing private method for testing
    public testBuildMessages(history: HistoryItem[]) {
        // @ts-expect-error - accessing private method for testing
        return this.buildOpenRouterMessages(history);
    }
}

// Create provider instances with dummy API keys (we won't make real API calls)
const anthropicProvider = new TestableAnthropicProvider({
    apiKey: "test-key",
    model: "claude-sonnet-4-5",
});

const openaiProvider = new TestableOpenAIProvider({
    apiKey: "test-key",
    model: "gpt-5",
});

const geminiProvider = new TestableGeminiProvider({
    apiKey: "test-key",
    model: "models/gemini-2.5-pro",
});

const openrouterProvider = new TestableOpenRouterProvider({
    apiKey: "test-key",
    model: "anthropic/claude-sonnet-4-5",
});

// ============================================================================
// Test data
// ============================================================================

const emptyHistory: HistoryItem[] = [];

const simpleConversation: HistoryItem[] = [
    { role: "user", content: "Hello, how are you?" },
    { role: "assistant", content: "I'm doing well, thank you!" },
    { role: "user", content: "Can you help me with something?" },
];

const historyWithSystem: HistoryItem[] = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "What is 2+2?" },
    { role: "assistant", content: "2+2 equals 4." },
];

const historyWithToolCalls: HistoryItem[] = [
    { role: "user", content: "Search for weather in Seattle" },
    {
        role: "assistant",
        content: null,
        tool_calls: [
            {
                id: "call_123",
                name: "search_weather",
                arguments: { city: "Seattle" },
            },
        ],
    },
    {
        role: "tool",
        tool_call_id: "call_123",
        name: "search_weather",
        content: '{"temperature": 65, "condition": "cloudy"}',
    },
    { role: "assistant", content: "The weather in Seattle is 65°F and cloudy." },
];

const historyWithMultipleToolCalls: HistoryItem[] = [
    { role: "user", content: "Compare weather in Seattle and Portland" },
    {
        role: "assistant",
        content: "Let me check both cities.",
        tool_calls: [
            {
                id: "call_1",
                name: "search_weather",
                arguments: { city: "Seattle" },
            },
            {
                id: "call_2",
                name: "search_weather",
                arguments: { city: "Portland" },
            },
        ],
    },
    {
        role: "tool",
        tool_call_id: "call_1",
        name: "search_weather",
        content: '{"temperature": 65}',
    },
    {
        role: "tool",
        tool_call_id: "call_2",
        name: "search_weather",
        content: '{"temperature": 70}',
    },
];

const historyWithObjectContent: HistoryItem[] = [
    { role: "user", content: "Get data" },
    {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_obj", name: "get_data", arguments: {} }],
    },
    {
        role: "tool",
        tool_call_id: "call_obj",
        name: "get_data",
        content: { key: "value", nested: { a: 1 } },
    },
];

// ============================================================================
// Anthropic Provider Tests
// ============================================================================

describe("AnthropicProvider history handling", () => {
    test("empty history produces no messages", () => {
        const { messages, systemMessages } =
            anthropicProvider.testBuildMessages(emptyHistory);
        expect(messages).toEqual([]);
        expect(systemMessages).toEqual([]);
    });

    test("simple conversation maps user/assistant roles correctly", () => {
        const { messages, systemMessages } =
            anthropicProvider.testBuildMessages(simpleConversation);
        expect(systemMessages).toEqual([]);
        expect(messages).toHaveLength(3);
        expect(messages[0]).toEqual({ role: "user", content: "Hello, how are you?" });
        expect(messages[1]).toEqual({
            role: "assistant",
            content: "I'm doing well, thank you!",
        });
        expect(messages[2]).toEqual({
            role: "user",
            content: "Can you help me with something?",
        });
    });

    test("system messages go to separate systemMessages array", () => {
        const { messages, systemMessages } =
            anthropicProvider.testBuildMessages(historyWithSystem);
        expect(systemMessages).toEqual(["You are a helpful assistant."]);
        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe("user");
        expect(messages[1].role).toBe("assistant");
    });

    test("assistant with tool_calls maps to tool_use content blocks", () => {
        const { messages } =
            anthropicProvider.testBuildMessages(historyWithToolCalls);
        expect(messages).toHaveLength(4);

        // First message: user
        expect(messages[0].role).toBe("user");

        // Second message: assistant with tool_use
        expect(messages[1].role).toBe("assistant");
        expect(Array.isArray(messages[1].content)).toBe(true);
        const toolUseBlock = messages[1].content[0];
        expect(toolUseBlock.type).toBe("tool_use");
        expect(toolUseBlock.id).toBe("call_123");
        expect(toolUseBlock.name).toBe("search_weather");
        expect(toolUseBlock.input).toEqual({ city: "Seattle" });

        // Third message: tool result as user message with tool_result block
        expect(messages[2].role).toBe("user");
        expect(Array.isArray(messages[2].content)).toBe(true);
        const toolResultBlock = messages[2].content[0];
        expect(toolResultBlock.type).toBe("tool_result");
        expect(toolResultBlock.tool_use_id).toBe("call_123");

        // Fourth message: assistant text
        expect(messages[3].role).toBe("assistant");
        expect(messages[3].content).toBe(
            "The weather in Seattle is 65°F and cloudy."
        );
    });

    test("assistant with text and tool_calls includes both", () => {
        const { messages } =
            anthropicProvider.testBuildMessages(historyWithMultipleToolCalls);

        // The assistant message with text + tool_calls
        const assistantMsg = messages[1];
        expect(assistantMsg.role).toBe("assistant");
        expect(Array.isArray(assistantMsg.content)).toBe(true);
        // First block is text, then two tool_use blocks
        expect(assistantMsg.content[0]).toEqual({
            type: "text",
            text: "Let me check both cities.",
        });
        expect(assistantMsg.content[1].type).toBe("tool_use");
        expect(assistantMsg.content[2].type).toBe("tool_use");
    });

    test("tool result with object content is JSON-stringified", () => {
        const { messages } =
            anthropicProvider.testBuildMessages(historyWithObjectContent);
        const toolResultMsg = messages[2]; // tool result
        expect(toolResultMsg.role).toBe("user");
        const block = toolResultMsg.content[0];
        expect(block.content).toBe(
            JSON.stringify({ key: "value", nested: { a: 1 } })
        );
    });
});

// ============================================================================
// OpenAI Provider Tests
// ============================================================================

describe("OpenAIProvider history handling", () => {
    test("empty history produces no messages", () => {
        const messages = openaiProvider.testBuildMessages(emptyHistory);
        expect(messages).toEqual([]);
    });

    test("simple conversation maps roles directly", () => {
        const messages = openaiProvider.testBuildMessages(simpleConversation);
        expect(messages).toHaveLength(3);
        expect(messages[0]).toEqual({
            role: "user",
            content: "Hello, how are you?",
        });
        expect(messages[1]).toEqual({
            role: "assistant",
            content: "I'm doing well, thank you!",
        });
        expect(messages[2]).toEqual({
            role: "user",
            content: "Can you help me with something?",
        });
    });

    test("system messages map to system role", () => {
        const messages = openaiProvider.testBuildMessages(historyWithSystem);
        expect(messages).toHaveLength(3);
        expect(messages[0]).toEqual({
            role: "system",
            content: "You are a helpful assistant.",
        });
    });

    test("assistant with tool_calls maps to OpenAI format", () => {
        const messages = openaiProvider.testBuildMessages(historyWithToolCalls);
        expect(messages).toHaveLength(4);

        // Assistant with tool_calls
        const assistantMsg = messages[1] as Record<string, unknown>;
        expect(assistantMsg.role).toBe("assistant");
        expect(assistantMsg.content).toBeNull();
        const toolCalls = assistantMsg.tool_calls as Array<Record<string, unknown>>;
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls[0].id).toBe("call_123");
        expect(toolCalls[0].type).toBe("function");
        const fn = toolCalls[0].function as Record<string, unknown>;
        expect(fn.name).toBe("search_weather");
        expect(fn.arguments).toBe(JSON.stringify({ city: "Seattle" }));

        // Tool result
        const toolMsg = messages[2] as Record<string, unknown>;
        expect(toolMsg.role).toBe("tool");
        expect(toolMsg.tool_call_id).toBe("call_123");
    });

    test("tool result with object content is JSON-stringified", () => {
        const messages = openaiProvider.testBuildMessages(
            historyWithObjectContent
        );
        const toolMsg = messages[2] as Record<string, unknown>;
        expect(toolMsg.role).toBe("tool");
        expect(toolMsg.content).toBe(
            JSON.stringify({ key: "value", nested: { a: 1 } })
        );
    });
});

// ============================================================================
// Gemini Provider Tests
// ============================================================================

describe("GeminiProvider history handling", () => {
    test("empty history produces no contents", () => {
        const { contents, systemInstructions } =
            geminiProvider.testBuildContents(emptyHistory);
        expect(contents).toEqual([]);
        expect(systemInstructions).toEqual([]);
    });

    test("simple conversation maps user to 'user' and assistant to 'model'", () => {
        const { contents } =
            geminiProvider.testBuildContents(simpleConversation);
        expect(contents).toHaveLength(3);
        expect(contents[0]).toEqual({
            role: "user",
            parts: [{ text: "Hello, how are you?" }],
        });
        expect(contents[1]).toEqual({
            role: "model",
            parts: [{ text: "I'm doing well, thank you!" }],
        });
        expect(contents[2]).toEqual({
            role: "user",
            parts: [{ text: "Can you help me with something?" }],
        });
    });

    test("system messages go to systemInstructions", () => {
        const { contents, systemInstructions } =
            geminiProvider.testBuildContents(historyWithSystem);
        expect(systemInstructions).toEqual(["You are a helpful assistant."]);
        expect(contents).toHaveLength(2);
        expect(contents[0].role).toBe("user");
        expect(contents[1].role).toBe("model");
    });

    test("assistant with tool_calls maps to functionCall parts", () => {
        const { contents } =
            geminiProvider.testBuildContents(historyWithToolCalls);
        expect(contents).toHaveLength(4);

        // Assistant with functionCall
        const modelMsg = contents[1];
        expect(modelMsg.role).toBe("model");
        const fcPart = modelMsg.parts[0] as Record<string, unknown>;
        const functionCall = fcPart.functionCall as Record<string, unknown>;
        expect(functionCall.name).toBe("search_weather");
        expect(functionCall.args).toEqual({ city: "Seattle" });

        // Tool result as user with functionResponse
        const toolMsg = contents[2];
        expect(toolMsg.role).toBe("user");
        const frPart = toolMsg.parts[0] as Record<string, unknown>;
        const functionResponse = frPart.functionResponse as Record<string, unknown>;
        expect(functionResponse.name).toBe("search_weather");
    });

    test("assistant with text and tool_calls includes both parts", () => {
        const { contents } =
            geminiProvider.testBuildContents(historyWithMultipleToolCalls);

        const modelMsg = contents[1];
        expect(modelMsg.role).toBe("model");
        // Text part + 2 functionCall parts
        expect(modelMsg.parts).toHaveLength(3);
        expect(modelMsg.parts[0]).toEqual({ text: "Let me check both cities." });
        expect((modelMsg.parts[1] as Record<string, unknown>).functionCall).toBeDefined();
        expect((modelMsg.parts[2] as Record<string, unknown>).functionCall).toBeDefined();
    });

    test("tool result with object content is passed as response object", () => {
        const { contents } =
            geminiProvider.testBuildContents(historyWithObjectContent);
        const toolMsg = contents[2];
        expect(toolMsg.role).toBe("user");
        const frPart = toolMsg.parts[0] as Record<string, unknown>;
        const functionResponse = frPart.functionResponse as Record<string, unknown>;
        // Object content should be passed directly
        expect(functionResponse.response).toEqual({
            key: "value",
            nested: { a: 1 },
        });
    });

    test("tool result with string content wraps in result object", () => {
        const history: HistoryItem[] = [
            { role: "user", content: "test" },
            {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "c1", name: "tool1", arguments: {} }],
            },
            {
                role: "tool",
                tool_call_id: "c1",
                name: "tool1",
                content: "plain string result",
            },
        ];
        const { contents } = geminiProvider.testBuildContents(history);
        const toolMsg = contents[2];
        const frPart = toolMsg.parts[0] as Record<string, unknown>;
        const functionResponse = frPart.functionResponse as Record<string, unknown>;
        expect(functionResponse.response).toEqual({
            result: "plain string result",
        });
    });
});

// ============================================================================
// OpenRouter Provider Tests (OpenAI-compatible)
// ============================================================================

describe("OpenRouterProvider history handling", () => {
    test("empty history produces no messages", () => {
        const messages = openrouterProvider.testBuildMessages(emptyHistory);
        expect(messages).toEqual([]);
    });

    test("simple conversation maps roles directly (same as OpenAI)", () => {
        const messages =
            openrouterProvider.testBuildMessages(simpleConversation);
        expect(messages).toHaveLength(3);
        expect(messages[0]).toEqual({
            role: "user",
            content: "Hello, how are you?",
        });
        expect(messages[1]).toEqual({
            role: "assistant",
            content: "I'm doing well, thank you!",
        });
    });

    test("system messages map to system role", () => {
        const messages =
            openrouterProvider.testBuildMessages(historyWithSystem);
        expect(messages[0]).toEqual({
            role: "system",
            content: "You are a helpful assistant.",
        });
    });

    test("tool_calls and tool results map same as OpenAI", () => {
        const messages =
            openrouterProvider.testBuildMessages(historyWithToolCalls);
        expect(messages).toHaveLength(4);

        const assistantMsg = messages[1] as Record<string, unknown>;
        expect(assistantMsg.role).toBe("assistant");
        const toolCalls = assistantMsg.tool_calls as Array<Record<string, unknown>>;
        expect(toolCalls[0].type).toBe("function");

        const toolMsg = messages[2] as Record<string, unknown>;
        expect(toolMsg.role).toBe("tool");
        expect(toolMsg.tool_call_id).toBe("call_123");
    });
});

// ============================================================================
// Cross-provider consistency tests
// ============================================================================

describe("Cross-provider consistency", () => {
    test("all providers handle empty history gracefully", () => {
        const anthropic = anthropicProvider.testBuildMessages(emptyHistory);
        const openai = openaiProvider.testBuildMessages(emptyHistory);
        const gemini = geminiProvider.testBuildContents(emptyHistory);
        const openrouter = openrouterProvider.testBuildMessages(emptyHistory);

        expect(anthropic.messages).toHaveLength(0);
        expect(openai).toHaveLength(0);
        expect(gemini.contents).toHaveLength(0);
        expect(openrouter).toHaveLength(0);
    });

    test("all providers produce same number of non-system messages for simple conversation", () => {
        const anthropic = anthropicProvider.testBuildMessages(simpleConversation);
        const openai = openaiProvider.testBuildMessages(simpleConversation);
        const gemini = geminiProvider.testBuildContents(simpleConversation);
        const openrouter = openrouterProvider.testBuildMessages(simpleConversation);

        // All should have 3 messages (no system messages in this history)
        expect(anthropic.messages).toHaveLength(3);
        expect(openai).toHaveLength(3);
        expect(gemini.contents).toHaveLength(3);
        expect(openrouter).toHaveLength(3);
    });

    test("system messages are extracted separately for Anthropic and Gemini", () => {
        const anthropic = anthropicProvider.testBuildMessages(historyWithSystem);
        const gemini = geminiProvider.testBuildContents(historyWithSystem);

        // Anthropic and Gemini extract system messages separately
        expect(anthropic.systemMessages).toHaveLength(1);
        expect(gemini.systemInstructions).toHaveLength(1);

        // Messages/contents should not include system messages
        expect(anthropic.messages).toHaveLength(2);
        expect(gemini.contents).toHaveLength(2);
    });

    test("system messages are inline for OpenAI and OpenRouter", () => {
        const openai = openaiProvider.testBuildMessages(historyWithSystem);
        const openrouter = openrouterProvider.testBuildMessages(historyWithSystem);

        // OpenAI and OpenRouter include system messages inline
        expect(openai).toHaveLength(3);
        expect(openrouter).toHaveLength(3);
        expect((openai[0] as Record<string, unknown>).role).toBe("system");
        expect((openrouter[0] as Record<string, unknown>).role).toBe("system");
    });
});
