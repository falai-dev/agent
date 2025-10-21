/**
 * History Conversion Utilities Unit Tests
 *
 * Tests the history conversion utilities that handle type-safe conversion
 * between HistoryItem and Event formats.
 */

import { expect, test, describe } from "bun:test";

import {
  historyItemToEvent,
  historyToEvents,
  eventToHistoryItem,
  eventsToHistory,
  userMessage,
  assistantMessage,
  toolMessage,
  systemMessage,
} from "../src/utils/history";

import { EventKind, MessageRole } from "../src/types";
import type { Event, MessageEventData, ToolEventData } from "../src/types";
import type { HistoryItem, UserHistoryItem, AssistantHistoryItem, ToolHistoryItem, SystemHistoryItem } from "../src/types/history";

describe("historyItemToEvent", () => {
  test("should convert user history item to event", () => {
    const userItem: UserHistoryItem = {
      role: "user",
      content: "Hello, how are you?",
      name: "TestUser",
    };

    const event = historyItemToEvent(userItem);

    expect(event.kind).toBe(EventKind.MESSAGE);
    expect(event.source).toBe(MessageRole.USER);
    expect(event.timestamp).toBeDefined();
    expect((event.data as MessageEventData).message).toBe("Hello, how are you?");
    expect((event.data as MessageEventData).participant?.display_name).toBe("TestUser");
  });

  test("should convert user history item without name", () => {
    const userItem: UserHistoryItem = {
      role: "user",
      content: "Hello without name",
    };

    const event = historyItemToEvent(userItem);

    expect(event.kind).toBe(EventKind.MESSAGE);
    expect(event.source).toBe(MessageRole.USER);
    expect((event.data as MessageEventData).message).toBe("Hello without name");
    expect((event.data as MessageEventData).participant?.display_name).toBe("User");
  });

  test("should convert assistant history item to event", () => {
    const assistantItem: AssistantHistoryItem = {
      role: "assistant",
      content: "I'm doing well, thank you!",
    };

    const event = historyItemToEvent(assistantItem);

    expect(event.kind).toBe(EventKind.MESSAGE);
    expect(event.source).toBe(MessageRole.ASSISTANT);
    expect((event.data as MessageEventData).message).toBe("I'm doing well, thank you!");
    expect((event.data as MessageEventData).participant?.display_name).toBe("Assistant");
  });

  test("should convert assistant history item with tool calls", () => {
    const assistantItem: AssistantHistoryItem = {
      role: "assistant",
      content: "I'll search for that information.",
      tool_calls: [
        {
          id: "call_123",
          name: "search_database",
          arguments: { query: "test query" },
        },
      ],
    };

    const event = historyItemToEvent(assistantItem);

    expect(event.kind).toBe(EventKind.MESSAGE);
    expect(event.source).toBe(MessageRole.ASSISTANT);
    expect((event.data as MessageEventData).message).toBe("I'll search for that information.");
    expect((event.data as MessageEventData).toolCalls).toEqual([
      {
        id: "call_123",
        name: "search_database",
        arguments: { query: "test query" },
      },
    ]);
  });

  test("should convert assistant history item with null content", () => {
    const assistantItem: AssistantHistoryItem = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_456",
          name: "get_weather",
          arguments: { location: "New York" },
        },
      ],
    };

    const event = historyItemToEvent(assistantItem);

    expect(event.kind).toBe(EventKind.MESSAGE);
    expect(event.source).toBe(MessageRole.ASSISTANT);
    expect((event.data as MessageEventData).message).toBe("");
    expect((event.data as MessageEventData).toolCalls).toBeDefined();
  });

  test("should convert tool history item to event", () => {
    const toolItem: ToolHistoryItem = {
      role: "tool",
      tool_call_id: "call_789",
      name: "search_database",
      content: { results: ["item1", "item2"] },
    };

    const event = historyItemToEvent(toolItem);

    expect(event.kind).toBe(EventKind.TOOL);
    expect(event.source).toBe(MessageRole.AGENT);
    expect((event.data as ToolEventData).tool_calls).toEqual([
      {
        tool_id: "call_789",
        arguments: {},
        result: {
          data: { results: ["item1", "item2"] },
        },
      },
    ]);
  });

  test("should convert system history item to event", () => {
    const systemItem: SystemHistoryItem = {
      role: "system",
      content: "System initialization complete",
    };

    const event = historyItemToEvent(systemItem);

    expect(event.kind).toBe(EventKind.MESSAGE);
    expect(event.source).toBe(MessageRole.SYSTEM);
    expect((event.data as MessageEventData).message).toBe("System initialization complete");
    expect((event.data as MessageEventData).participant?.display_name).toBe("System");
  });

  test("should throw error for invalid history item", () => {
    expect(() => historyItemToEvent(null as any)).toThrow("Invalid history item: must be a non-null object");
    expect(() => historyItemToEvent({} as any)).toThrow("Invalid history item: role is required and must be a string");
    expect(() => historyItemToEvent({ role: 123 } as any)).toThrow("Invalid history item: role is required and must be a string");
  });

  test("should throw error for invalid user item", () => {
    expect(() => historyItemToEvent({ role: "user" } as any)).toThrow("Invalid user history item: content must be a string");
    expect(() => historyItemToEvent({ role: "user", content: 123 } as any)).toThrow("Invalid user history item: content must be a string");
  });

  test("should throw error for invalid assistant item", () => {
    expect(() => historyItemToEvent({ role: "assistant", content: 123 } as any)).toThrow("Invalid assistant history item: content must be a string or null");
  });

  test("should throw error for invalid tool item", () => {
    expect(() => historyItemToEvent({ role: "tool" } as any)).toThrow("Invalid tool history item: tool_call_id is required and must be a string");
    expect(() => historyItemToEvent({ role: "tool", tool_call_id: "123" } as any)).toThrow("Invalid tool history item: name is required and must be a string");
  });

  test("should throw error for invalid system item", () => {
    expect(() => historyItemToEvent({ role: "system" } as any)).toThrow("Invalid system history item: content must be a string");
    expect(() => historyItemToEvent({ role: "system", content: 123 } as any)).toThrow("Invalid system history item: content must be a string");
  });

  test("should throw error for unknown role", () => {
    expect(() => historyItemToEvent({ role: "unknown" } as any)).toThrow("Invalid history item role: unknown");
  });
});

describe("historyToEvents", () => {
  test("should convert array of history items to events", () => {
    const history: HistoryItem[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "system", content: "Session started" },
    ];

    const events = historyToEvents(history);

    expect(events).toHaveLength(3);
    expect(events[0].kind).toBe(EventKind.MESSAGE);
    expect(events[0].source).toBe(MessageRole.USER);
    expect(events[1].kind).toBe(EventKind.MESSAGE);
    expect(events[1].source).toBe(MessageRole.ASSISTANT);
    expect(events[2].kind).toBe(EventKind.MESSAGE);
    expect(events[2].source).toBe(MessageRole.SYSTEM);
  });

  test("should handle empty history array", () => {
    const events = historyToEvents([]);
    expect(events).toHaveLength(0);
  });

  test("should throw error for invalid history array", () => {
    expect(() => historyToEvents(null as any)).toThrow("Invalid history: must be an array");
    expect(() => historyToEvents("not an array" as any)).toThrow("Invalid history: must be an array");
  });

  test("should throw error with index information for invalid items", () => {
    const history = [
      { role: "user", content: "Valid message" },
      { role: "invalid" } as any,
    ];

    expect(() => historyToEvents(history)).toThrow("Error converting history item at index 1");
  });
});

describe("eventToHistoryItem", () => {
  test("should convert user message event to history item", () => {
    const event: Event<MessageEventData> = {
      kind: EventKind.MESSAGE,
      source: MessageRole.USER,
      timestamp: new Date().toISOString(),
      data: {
        participant: { display_name: "TestUser" },
        message: "Hello from event",
      },
    };

    const historyItem = eventToHistoryItem(event);

    expect(historyItem.role).toBe("user");
    expect((historyItem as UserHistoryItem).content).toBe("Hello from event");
    expect((historyItem as UserHistoryItem).name).toBe("TestUser");
  });

  test("should convert user message event without custom name", () => {
    const event: Event<MessageEventData> = {
      kind: EventKind.MESSAGE,
      source: MessageRole.USER,
      timestamp: new Date().toISOString(),
      data: {
        participant: { display_name: "User" },
        message: "Hello default user",
      },
    };

    const historyItem = eventToHistoryItem(event);

    expect(historyItem.role).toBe("user");
    expect((historyItem as UserHistoryItem).content).toBe("Hello default user");
    expect((historyItem as UserHistoryItem).name).toBeUndefined();
  });

  test("should convert assistant message event to history item", () => {
    const event: Event<MessageEventData> = {
      kind: EventKind.MESSAGE,
      source: MessageRole.ASSISTANT,
      timestamp: new Date().toISOString(),
      data: {
        participant: { display_name: "Assistant" },
        message: "Hello from assistant",
      },
    };

    const historyItem = eventToHistoryItem(event);

    expect(historyItem.role).toBe("assistant");
    expect((historyItem as AssistantHistoryItem).content).toBe("Hello from assistant");
  });

  test("should convert assistant message event with tool calls", () => {
    const event: Event<MessageEventData> = {
      kind: EventKind.MESSAGE,
      source: MessageRole.ASSISTANT,
      timestamp: new Date().toISOString(),
      data: {
        participant: { display_name: "Assistant" },
        message: "I'll help you with that",
        toolCalls: [
          {
            id: "call_123",
            name: "search_tool",
            arguments: { query: "test" },
          },
        ],
      },
    };

    const historyItem = eventToHistoryItem(event);

    expect(historyItem.role).toBe("assistant");
    expect((historyItem as AssistantHistoryItem).content).toBe("I'll help you with that");
    expect((historyItem as AssistantHistoryItem).tool_calls).toEqual([
      {
        id: "call_123",
        name: "search_tool",
        arguments: { query: "test" },
      },
    ]);
  });

  test("should convert tool event to history item", () => {
    const event: Event<ToolEventData> = {
      kind: EventKind.TOOL,
      source: MessageRole.AGENT,
      timestamp: new Date().toISOString(),
      data: {
        tool_calls: [
          {
            tool_id: "call_456",
            arguments: {},
            result: {
              data: "Tool execution result",
            },
          },
        ],
      },
    };

    const historyItem = eventToHistoryItem(event);

    expect(historyItem.role).toBe("tool");
    expect((historyItem as ToolHistoryItem).tool_call_id).toBe("call_456");
    expect((historyItem as ToolHistoryItem).name).toBe("call_456");
    expect((historyItem as ToolHistoryItem).content).toBe("Tool execution result");
  });

  test("should convert system message event to history item", () => {
    const event: Event<MessageEventData> = {
      kind: EventKind.MESSAGE,
      source: MessageRole.SYSTEM,
      timestamp: new Date().toISOString(),
      data: {
        participant: { display_name: "System" },
        message: "System message",
      },
    };

    const historyItem = eventToHistoryItem(event);

    expect(historyItem.role).toBe("system");
    expect((historyItem as SystemHistoryItem).content).toBe("System message");
  });

  test("should throw error for invalid event", () => {
    expect(() => eventToHistoryItem(null as any)).toThrow("Invalid event: must be a non-null object");
    expect(() => eventToHistoryItem({} as any)).toThrow("Invalid event: kind, source, and data are required");
  });

  test("should throw error for invalid message event", () => {
    const invalidEvent = {
      kind: EventKind.MESSAGE,
      source: MessageRole.USER,
      timestamp: new Date().toISOString(),
      data: {},
    };

    expect(() => eventToHistoryItem(invalidEvent as any)).toThrow("Invalid message event: message is required");
  });

  test("should throw error for invalid tool event", () => {
    const invalidEvent = {
      kind: EventKind.TOOL,
      source: MessageRole.AGENT,
      timestamp: new Date().toISOString(),
      data: {},
    };

    expect(() => eventToHistoryItem(invalidEvent as any)).toThrow("Invalid tool event: tool_calls array is required and must not be empty");
  });
});

describe("eventsToHistory", () => {
  test("should convert array of events to history items", () => {
    const events: Event[] = [
      {
        kind: EventKind.MESSAGE,
        source: MessageRole.USER,
        timestamp: new Date().toISOString(),
        data: {
          participant: { display_name: "User" },
          message: "Hello",
        },
      },
      {
        kind: EventKind.MESSAGE,
        source: MessageRole.ASSISTANT,
        timestamp: new Date().toISOString(),
        data: {
          participant: { display_name: "Assistant" },
          message: "Hi there!",
        },
      },
    ];

    const history = eventsToHistory(events);

    expect(history).toHaveLength(2);
    expect(history[0].role).toBe("user");
    expect(history[1].role).toBe("assistant");
  });

  test("should handle empty events array", () => {
    const history = eventsToHistory([]);
    expect(history).toHaveLength(0);
  });

  test("should throw error for invalid events array", () => {
    expect(() => eventsToHistory(null as any)).toThrow("Invalid events: must be an array");
  });

  test("should throw error with index information for invalid events", () => {
    const events = [
      {
        kind: EventKind.MESSAGE,
        source: MessageRole.USER,
        timestamp: new Date().toISOString(),
        data: { participant: { display_name: "User" }, message: "Valid" },
      },
      {} as any, // Invalid event
    ];

    expect(() => eventsToHistory(events)).toThrow("Error converting event at index 1");
  });
});

describe("Round-trip conversions", () => {
  test("should maintain data integrity in user message round-trip", () => {
    const originalItem: UserHistoryItem = {
      role: "user",
      content: "Test message",
      name: "TestUser",
    };

    const event = historyItemToEvent(originalItem);
    const convertedItem = eventToHistoryItem(event) as UserHistoryItem;

    expect(convertedItem.role).toBe(originalItem.role);
    expect(convertedItem.content).toBe(originalItem.content);
    expect(convertedItem.name).toBe(originalItem.name);
  });

  test("should maintain data integrity in assistant message round-trip", () => {
    const originalItem: AssistantHistoryItem = {
      role: "assistant",
      content: "Assistant response",
      tool_calls: [
        {
          id: "call_123",
          name: "test_tool",
          arguments: { param: "value" },
        },
      ],
    };

    const event = historyItemToEvent(originalItem);
    const convertedItem = eventToHistoryItem(event) as AssistantHistoryItem;

    expect(convertedItem.role).toBe(originalItem.role);
    expect(convertedItem.content).toBe(originalItem.content);
    expect(convertedItem.tool_calls).toEqual(originalItem.tool_calls);
  });

  test("should maintain data integrity in tool message round-trip", () => {
    const originalItem: ToolHistoryItem = {
      role: "tool",
      tool_call_id: "call_456",
      name: "search_tool",
      content: { results: ["item1", "item2"] },
    };

    const event = historyItemToEvent(originalItem);
    const convertedItem = eventToHistoryItem(event) as ToolHistoryItem;

    expect(convertedItem.role).toBe(originalItem.role);
    expect(convertedItem.tool_call_id).toBe(originalItem.tool_call_id);
    expect(convertedItem.content).toEqual(originalItem.content);
  });

  test("should maintain data integrity in system message round-trip", () => {
    const originalItem: SystemHistoryItem = {
      role: "system",
      content: "System notification",
    };

    const event = historyItemToEvent(originalItem);
    const convertedItem = eventToHistoryItem(event) as SystemHistoryItem;

    expect(convertedItem.role).toBe(originalItem.role);
    expect(convertedItem.content).toBe(originalItem.content);
  });

  test("should maintain data integrity in full history round-trip", () => {
    const originalHistory: HistoryItem[] = [
      { role: "user", content: "Hello", name: "TestUser" },
      { role: "assistant", content: "Hi there!" },
      { role: "tool", tool_call_id: "call_123", name: "test_tool", content: "result" },
      { role: "system", content: "System message" },
    ];

    const events = historyToEvents(originalHistory);
    const convertedHistory = eventsToHistory(events);

    expect(convertedHistory).toHaveLength(originalHistory.length);
    
    // Check user message
    expect(convertedHistory[0].role).toBe("user");
    expect((convertedHistory[0] as UserHistoryItem).content).toBe("Hello");
    expect((convertedHistory[0] as UserHistoryItem).name).toBe("TestUser");
    
    // Check assistant message
    expect(convertedHistory[1].role).toBe("assistant");
    expect((convertedHistory[1] as AssistantHistoryItem).content).toBe("Hi there!");
    
    // Check tool message
    expect(convertedHistory[2].role).toBe("tool");
    expect((convertedHistory[2] as ToolHistoryItem).tool_call_id).toBe("call_123");
    expect((convertedHistory[2] as ToolHistoryItem).content).toBe("result");
    
    // Check system message
    expect(convertedHistory[3].role).toBe("system");
    expect((convertedHistory[3] as SystemHistoryItem).content).toBe("System message");
  });
});

describe("Helper functions", () => {
  test("userMessage helper should create valid user history item", () => {
    const item = userMessage("Test content", "TestUser");
    
    expect(item.role).toBe("user");
    expect((item as UserHistoryItem).content).toBe("Test content");
    expect((item as UserHistoryItem).name).toBe("TestUser");
  });

  test("userMessage helper should work without name", () => {
    const item = userMessage("Test content");
    
    expect(item.role).toBe("user");
    expect((item as UserHistoryItem).content).toBe("Test content");
    expect((item as UserHistoryItem).name).toBeUndefined();
  });

  test("assistantMessage helper should create valid assistant history item", () => {
    const toolCalls = [{ id: "call_123", name: "test_tool", arguments: { param: "value" } }];
    const item = assistantMessage("Assistant response", toolCalls);
    
    expect(item.role).toBe("assistant");
    expect((item as AssistantHistoryItem).content).toBe("Assistant response");
    expect((item as AssistantHistoryItem).tool_calls).toEqual(toolCalls);
  });

  test("assistantMessage helper should work with null content", () => {
    const item = assistantMessage(null);
    
    expect(item.role).toBe("assistant");
    expect((item as AssistantHistoryItem).content).toBe(null);
    expect((item as AssistantHistoryItem).tool_calls).toBeUndefined();
  });

  test("toolMessage helper should create valid tool history item", () => {
    const item = toolMessage("call_456", "search_tool", { results: ["item1"] });
    
    expect(item.role).toBe("tool");
    expect((item as ToolHistoryItem).tool_call_id).toBe("call_456");
    expect((item as ToolHistoryItem).name).toBe("search_tool");
    expect((item as ToolHistoryItem).content).toEqual({ results: ["item1"] });
  });

  test("systemMessage helper should create valid system history item", () => {
    const item = systemMessage("System notification");
    
    expect(item.role).toBe("system");
    expect((item as SystemHistoryItem).content).toBe("System notification");
  });
});