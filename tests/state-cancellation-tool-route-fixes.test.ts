/**
 * Bug Condition Exploration Tests
 *
 * These tests encode the EXPECTED (correct) behavior for four bugs:
 * 1. Session state not synced after stream()/generate() completion
 * 2. AbortSignal not propagated to processRouteResponse/handleRouteCompletion
 * 3. Tool follow-up structured data discarded by executeUnifiedToolLoop
 * 4. Optional-only routes incorrectly marked as complete
 *
 * On UNFIXED code, these tests are EXPECTED TO FAIL — failure confirms the bugs exist.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8**
 */
import { expect, test, describe } from "bun:test";
import fc from "fast-check";
import { Agent, Route, createSession, MemoryAdapter } from "../src/index";
import { MockProvider, MockProviderFactory } from "./mock-provider";

// ─── Test Data Types ───────────────────────────────────────────────────────────

interface TestData {
  name?: string;
  email?: string;
  preference?: string;
  notes?: string;
  issue?: string;
  category?: string;
}

// ─── Bug 1: Session State Sync ─────────────────────────────────────────────────

describe("Bug 1: Session state sync after stream()/generate() completion", () => {
  /**
   * Bug Condition: After generate() completes (not in override-history mode),
   * agent.session.current should reflect the finalized session with route, step, data.
   * On unfixed code, agent.session.current will be stale — it won't have the
   * updated currentRoute/currentStep from the response.
   *
   * Validates: Requirements 1.2, 1.3
   */
  test("generate() syncs finalized session with route/step to agent.session.current", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "SessionSyncTestAgent",
      description: "Tests session sync after generate",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
        },
        additionalProperties: false,
      },
    });

    agent.createRoute({
      title: "Onboarding",
      description: "Collect user info",
      when: ["User wants to onboard"],
      requiredFields: ["name", "email"],
      steps: [
        {
          id: "collect_name",
          prompt: "What is your name?",
          collect: ["name"],
        },
        {
          id: "collect_email",
          prompt: "What is your email?",
          collect: ["email"],
          requires: ["name"],
        },
      ],
    });

    // Call chat() (which delegates to generate()) — this should sync the finalized session back
    const result = await agent.chat("Hello, I want to onboard");

    // The finalized session should have currentRoute and currentStep set
    const currentSession = agent.session.current;
    expect(currentSession).toBeDefined();
    expect(currentSession!.currentRoute).toBeDefined();
    expect(currentSession!.currentRoute!.id).toBeDefined();
    // The session should reflect the route that was selected
    expect(currentSession!.currentStep).toBeDefined();
    expect(currentSession!.currentStep!.id).toBeDefined();
  });

  /**
   * Bug Condition: After stream() completes (not in override-history mode),
   * agent.session.current should reflect the finalized session.
   * On unfixed code, stream() only calls addMessage() which updates history
   * but not route/step/data.
   *
   * Validates: Requirements 1.1, 1.2
   */
  test("stream() syncs finalized session with route/step to agent.session.current", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "StreamSyncTestAgent",
      description: "Tests session sync after stream",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          issue: { type: "string" },
          category: { type: "string" },
        },
        additionalProperties: false,
      },
    });

    agent.createRoute({
      title: "Support",
      description: "Handle support requests",
      when: ["User needs support"],
      requiredFields: ["issue", "category"],
      steps: [
        {
          id: "collect_issue",
          prompt: "What issue are you experiencing?",
          collect: ["issue"],
        },
        {
          id: "collect_category",
          prompt: "What category?",
          collect: ["category"],
          requires: ["issue"],
        },
      ],
    });

    // Consume the stream fully
    for await (const chunk of agent.stream("I need help with something")) {
      // Just consume
    }

    // After streaming, agent.session.current should have route/step info
    const currentSession = agent.session.current;
    expect(currentSession).toBeDefined();
    expect(currentSession!.currentRoute).toBeDefined();
    expect(currentSession!.currentRoute!.id).toBeDefined();
    expect(currentSession!.currentStep).toBeDefined();
    expect(currentSession!.currentStep!.id).toBeDefined();
  });
});

// ─── Bug 2: Signal Propagation ─────────────────────────────────────────────────

describe("Bug 2: AbortSignal not propagated to processRouteResponse/handleRouteCompletion", () => {
  /**
   * Bug Condition: When generateUnifiedResponse() delegates to processRouteResponse(),
   * it passes signal: undefined instead of the actual AbortSignal from params.
   * We verify by checking that the provider receives the signal.
   *
   * Validates: Requirements 1.4, 1.5
   */
  test("AbortSignal is forwarded to AI provider through processRouteResponse", async () => {
    let receivedSignal: AbortSignal | undefined = undefined;

    // Create a provider that captures the signal it receives
    const signalCapturingProvider: MockProvider & { lastSignal?: AbortSignal } = Object.assign(
      new MockProvider(),
      { lastSignal: undefined as AbortSignal | undefined }
    );

    // Override generateMessage to capture the signal
    const originalGenerateMessage = signalCapturingProvider.generateMessage.bind(signalCapturingProvider);
    signalCapturingProvider.generateMessage = async (input: any) => {
      // Capture the signal from the LAST call (which is the route response call)
      receivedSignal = input.signal;
      return originalGenerateMessage(input);
    };

    const agent = new Agent<unknown, TestData>({
      name: "SignalTestAgent",
      description: "Tests signal propagation",
      provider: signalCapturingProvider,
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        additionalProperties: false,
      },
    });

    agent.createRoute({
      title: "Signal Test Route",
      description: "Route for testing signal propagation",
      when: ["User sends message"],
      requiredFields: ["name"],
      steps: [
        {
          id: "collect_name",
          prompt: "What is your name?",
          collect: ["name"],
        },
      ],
    });

    // Create an AbortController and pass its signal
    const controller = new AbortController();
    const signal = controller.signal;

    // Call chat (which delegates to generate) with a signal
    await agent.chat("Hello", { signal });

    // The provider should have received the signal in the route response call (not undefined)
    // On unfixed code, signal will be undefined because generateUnifiedResponse
    // passes signal: undefined to processRouteResponse
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).toBe(signal);
  });
});

// ─── Bug 3: Tool Follow-Up Structured Data ─────────────────────────────────────

describe("Bug 3: Tool follow-up structured data discarded", () => {
  /**
   * Bug Condition: When executeUnifiedToolLoop() makes a follow-up AI call that
   * returns structured data, the structured response is discarded and not returned
   * to the caller. processRouteResponse() then passes the ORIGINAL AI response
   * to collectDataFromResponse() instead of the follow-up response.
   *
   * We test this by creating a scenario where:
   * 1. Initial AI call returns tool calls (triggering the tool loop)
   * 2. Follow-up AI call returns structured data with collected fields
   * 3. Verify the collected data from the follow-up is used
   *
   * Validates: Requirements 1.6, 1.7
   */
  test("follow-up AI call structured data is used for data collection", async () => {
    let callCount = 0;

    // Create a provider that handles routing, step selection, and route response
    const toolLoopProvider = new MockProvider();
    toolLoopProvider.generateMessage = async (input: any) => {
      callCount++;
      const schema = input.parameters?.jsonSchema as any;
      const schemaName = input.parameters?.schemaName || '';

      // Handle routing calls
      if (schema?.properties?.routes?.properties) {
        const routeIds = Object.keys(schema.properties.routes.properties);
        const routes: Record<string, number> = {};
        routeIds.forEach((routeId, index) => {
          routes[routeId] = 80 - (index * 10);
        });
        return {
          message: "Routing",
          metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
          structured: { context: "test", routes, responseDirectives: [] },
        };
      }

      // Handle step selection calls
      if (schema?.properties?.selectedStepId) {
        const stepIds = schema.properties.selectedStepId?.enum || [];
        return {
          message: "Step selection",
          metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
          structured: { reasoning: "test", selectedStepId: stepIds[0] },
        };
      }

      // Handle data extraction / pre-extraction calls
      if (schemaName.includes('extraction') || schemaName.includes('data')) {
        return {
          message: "",
          metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
          structured: {},
        };
      }

      // Route response call — check if this is the first response or follow-up
      // The first route response call returns tool calls
      if (schemaName === 'response_output' || schemaName === 'tool_followup') {
        if (schemaName === 'response_output') {
          // Initial route response: return tool calls to trigger the tool loop
          return {
            message: "Let me look that up for you.",
            metadata: { model: "mock", tokensUsed: 50, finishReason: "stop" },
            structured: {
              message: "Let me look that up for you.",
              toolCalls: [
                { toolName: "lookup_user", arguments: { query: "test" } },
              ],
            },
          };
        }
        // Follow-up after tool execution: returns structured data with name field
        return {
          message: "I found your information. Your name is John.",
          metadata: { model: "mock", tokensUsed: 50, finishReason: "stop" },
          structured: {
            message: "I found your information. Your name is John.",
            name: "John",
          },
        };
      }

      // Default fallback
      return {
        message: "Hello",
        metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
        structured: { message: "Hello" },
      };
    };

    const agent = new Agent<unknown, TestData>({
      name: "ToolDataTestAgent",
      description: "Tests tool follow-up data collection",
      provider: toolLoopProvider,
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
        },
      },
    });

    // Register a tool that the AI can call
    agent.createTool({
      id: "lookup_user",
      name: "lookup_user",
      description: "Look up user information",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      handler: async () => ({
        success: true,
        data: { name: "John" },
      }),
    });

    agent.createRoute({
      title: "User Lookup",
      description: "Look up user info",
      when: ["User wants to look up info"],
      requiredFields: ["name"],
      steps: [
        {
          id: "collect_name",
          prompt: "Let me find your name.",
          collect: ["name"],
        },
      ],
    });

    // Call chat (which delegates to generate) — this triggers the tool loop
    const result = await agent.chat("Look up my info");

    // On unfixed code, the follow-up structured data (with name: "John") is discarded
    // and collectDataFromResponse uses the original response (which has toolCalls, not name)
    // So agent data should have name collected from the follow-up
    const collectedData = agent.getCollectedData();
    expect(collectedData.name).toBe("John");
  });
});

// ─── Bug 4: Optional-Only Route Completion ──────────────────────────────────────

describe("Bug 4: Optional-only routes incorrectly marked as complete", () => {
  /**
   * Bug Condition: When a route has optionalFields but no requiredFields,
   * isComplete() returns true and getCompletionProgress() returns 1.
   * This causes the routing engine to filter the route as "already completed".
   *
   * Expected behavior: isComplete() should return false and
   * getCompletionProgress() should return 0 for optional-only routes.
   *
   * Validates: Requirement 1.8
   */
  test("isComplete() returns false for route with only optionalFields", () => {
    const route = new Route<unknown, TestData>({
      title: "Optional Preferences",
      description: "Collect optional preferences",
      when: ["User wants to set preferences"],
      optionalFields: ["preference"],
      steps: [
        {
          id: "collect_preference",
          prompt: "What are your preferences?",
          collect: ["preference"],
        },
      ],
    });

    // On unfixed code, this returns true (BUG)
    // Expected: false — optional-only routes should only complete via END_ROUTE
    const result = route.isComplete({});
    expect(result).toBe(false);
  });

  test("getCompletionProgress() returns 0 for route with only optionalFields", () => {
    const route = new Route<unknown, TestData>({
      title: "Optional Notes",
      description: "Collect optional notes",
      when: ["User wants to add notes"],
      optionalFields: ["preference", "notes"],
      steps: [
        {
          id: "collect_notes",
          prompt: "Any notes?",
          collect: ["notes"],
        },
      ],
    });

    // On unfixed code, this returns 1 (BUG)
    // Expected: 0 — optional-only routes should only complete via END_ROUTE
    const progress = route.getCompletionProgress({});
    expect(progress).toBe(0);
  });

  test("isComplete() returns false even when optional fields have data", () => {
    const route = new Route<unknown, TestData>({
      title: "Optional With Data",
      description: "Optional route with some data filled",
      when: ["User provides preferences"],
      optionalFields: ["preference", "notes"],
      steps: [
        {
          id: "collect_prefs",
          prompt: "Preferences?",
          collect: ["preference", "notes"],
        },
      ],
    });

    // Even with data filled, optional-only routes should not auto-complete
    // They should only complete via END_ROUTE
    const result = route.isComplete({ preference: "dark mode", notes: "test" });
    expect(result).toBe(false);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// PRESERVATION PROPERTY TESTS
//
// These tests verify behaviors that MUST remain unchanged after the bugfix.
// They PASS on unfixed code because they test non-buggy paths.
//
// **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Property 5: Route Completion Logic for Required Fields ─────────────────────

describe("Preservation: Route completion logic for required fields", () => {
  /**
   * Property: For all route configs with requiredFields,
   * isComplete(data) equals requiredFields.every(f => data[f] != null && data[f] !== '')
   *
   * **Validates: Requirements 3.2, 3.3**
   */
  test("isComplete(data) matches requiredFields.every(f => data[f] != null && data[f] !== '')", () => {
    fc.assert(
      fc.property(
        // Generate a list of 1-5 required field names
        fc.array(
          fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,9}$/),
          { minLength: 1, maxLength: 5 }
        ).filter(arr => new Set(arr).size === arr.length), // unique field names
        // Generate data object with random field values (some present, some missing)
        fc.dictionary(
          fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,9}$/),
          fc.oneof(
            fc.constant(undefined),
            fc.constant(null),
            fc.constant(''),
            fc.string({ minLength: 1, maxLength: 20 })
          )
        ),
        (requiredFields, dataDict) => {
          const route = new Route<unknown, Record<string, unknown>>({
            title: "Test Route",
            description: "Test",
            when: ["test"],
            requiredFields: requiredFields,
            steps: [{ id: "step1", prompt: "test", collect: requiredFields }],
          });

          const data: Record<string, unknown> = { ...dataDict };

          const actual = route.isComplete(data);
          const expected = requiredFields.every(f => {
            const value = data[f];
            return value !== undefined && value !== null && value !== '';
          });

          expect(actual).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property: For all route configs with requiredFields,
   * getCompletionProgress(data) equals satisfiedCount / requiredFields.length
   *
   * **Validates: Requirements 3.2, 3.3**
   */
  test("getCompletionProgress(data) equals satisfiedCount / requiredFields.length", () => {
    fc.assert(
      fc.property(
        // Generate a list of 1-5 required field names
        fc.array(
          fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,9}$/),
          { minLength: 1, maxLength: 5 }
        ).filter(arr => new Set(arr).size === arr.length), // unique field names
        // Generate data object with random field values
        fc.dictionary(
          fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,9}$/),
          fc.oneof(
            fc.constant(undefined),
            fc.constant(null),
            fc.constant(''),
            fc.string({ minLength: 1, maxLength: 20 })
          )
        ),
        (requiredFields, dataDict) => {
          const route = new Route<unknown, Record<string, unknown>>({
            title: "Test Route",
            description: "Test",
            when: ["test"],
            requiredFields: requiredFields,
            steps: [{ id: "step1", prompt: "test", collect: requiredFields }],
          });

          const data: Record<string, unknown> = { ...dataDict };

          const actual = route.getCompletionProgress(data);
          const satisfiedCount = requiredFields.filter(f => {
            const value = data[f];
            return value !== undefined && value !== null && value !== '';
          }).length;
          const expected = satisfiedCount / requiredFields.length;

          expect(actual).toBeCloseTo(expected, 10);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Preservation: Routes with no requiredFields and no optionalFields
   * return isComplete() === false and getCompletionProgress() === 0
   *
   * **Validates: Requirement 3.4**
   */
  test("no-fields routes return isComplete()=false and getCompletionProgress()=0", () => {
    const route = new Route<unknown, Record<string, unknown>>({
      title: "No Fields Route",
      description: "Route with no required or optional fields",
      when: ["test"],
      steps: [{ id: "step1", prompt: "test" }],
    });

    expect(route.isComplete({})).toBe(false);
    expect(route.getCompletionProgress({})).toBe(0);
    // Even with arbitrary data, still false/0
    expect(route.isComplete({ foo: "bar", baz: 42 })).toBe(false);
    expect(route.getCompletionProgress({ foo: "bar", baz: 42 })).toBe(0);
  });
});

// ─── Property 6: Legacy API and Override-History Behavior ───────────────────────

describe("Preservation: Legacy API does not modify agent.session.current", () => {
  /**
   * Property: For all respond() calls with explicit session,
   * agent.session.current is unchanged before and after.
   *
   * Legacy callers manage their own session — respond() returns the finalized
   * session in the response but does NOT write to agent.session.current
   * (because getCurrentSession() returns undefined when session manager hasn't been initialized).
   *
   * **Validates: Requirement 3.1**
   */
  test("respond() with explicit session does not modify agent.session.current", async () => {
    const agent = new Agent<unknown, Record<string, unknown>>({
      name: "LegacyAPITestAgent",
      description: "Tests legacy API preservation",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        additionalProperties: false,
      },
    });

    agent.createRoute({
      title: "Legacy Route",
      description: "Route for legacy API test",
      when: ["User sends message"],
      requiredFields: ["name"],
      steps: [{ id: "step1", prompt: "What is your name?", collect: ["name"] }],
    });

    // Capture session.current BEFORE the call
    const sessionBefore = agent.session.current;

    // Call respond() directly with an explicit session (legacy API pattern)
    const explicitSession = createSession<Record<string, unknown>>({
      history: [{ role: "user", content: "Hello" }],
    });

    const result = await agent.respond({
      history: [{ role: "user", content: "Hello" }],
      session: explicitSession,
    });

    // agent.session.current should be unchanged (still undefined or same as before)
    // Legacy callers manage their own session externally
    const sessionAfter = agent.session.current;
    expect(sessionAfter).toEqual(sessionBefore);

    // The response should contain a finalized session (returned to caller)
    expect(result.session).toBeDefined();
  });
});

describe("Preservation: Override-history mode is fully stateless", () => {
  /**
   * Property: For all calls with options.history provided,
   * agent.session.current is unchanged before and after.
   *
   * Override-history mode is fully stateless — no history, route, step,
   * or data mutation on agent.session.current.
   *
   * **Validates: Requirement 3.7**
   */
  test("generate() with options.history does not modify agent.session.current", async () => {
    const agent = new Agent<unknown, Record<string, unknown>>({
      name: "OverrideHistoryTestAgent",
      description: "Tests override-history preservation",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        additionalProperties: false,
      },
    });

    agent.createRoute({
      title: "Override Route",
      description: "Route for override-history test",
      when: ["User sends message"],
      requiredFields: ["name"],
      steps: [{ id: "step1", prompt: "What is your name?", collect: ["name"] }],
    });

    // Initialize session so we have a baseline
    await agent.session.getOrCreate();
    const sessionBefore = agent.session.current;
    const historyBefore = agent.session.getHistory();

    // Call chat() with explicit history override
    await agent.chat("Hello override", {
      history: [{ role: "user", content: "Hello override" }],
    });

    // agent.session.current history should NOT have been modified
    const historyAfter = agent.session.getHistory();
    expect(historyAfter).toEqual(historyBefore);
  });

  test("stream() with options.history does not modify agent.session.current history", async () => {
    const agent = new Agent<unknown, Record<string, unknown>>({
      name: "StreamOverrideTestAgent",
      description: "Tests stream override-history preservation",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        additionalProperties: false,
      },
    });

    agent.createRoute({
      title: "Stream Override Route",
      description: "Route for stream override test",
      when: ["User sends message"],
      requiredFields: ["name"],
      steps: [{ id: "step1", prompt: "What is your name?", collect: ["name"] }],
    });

    // Initialize session so we have a baseline
    await agent.session.getOrCreate();
    const historyBefore = agent.session.getHistory();

    // Call stream() with explicit history override
    for await (const chunk of agent.stream("Hello stream override", {
      history: [{ role: "user", content: "Hello stream override" }],
    })) {
      // consume
    }

    // agent.session.current history should NOT have been modified
    const historyAfter = agent.session.getHistory();
    expect(historyAfter).toEqual(historyBefore);
  });
});

// ─── Preservation: No-Tool-Loop Uses Original Response ──────────────────────────

describe("Preservation: No-tool-loop uses original response for data collection", () => {
  /**
   * When no tool calls occur in processRouteResponse(), collectDataFromResponse()
   * uses the original AI response. This behavior must be preserved.
   *
   * **Validates: Requirement 3.5**
   */
  test("data is collected from original response when no tool calls occur", async () => {
    // Create a provider that returns structured data with a name field (no tool calls)
    const noToolProvider = new MockProvider();
    noToolProvider.generateMessage = async (input: any) => {
      const schema = input.parameters?.jsonSchema as any;
      const schemaName = input.parameters?.schemaName || '';

      // Handle routing calls
      if (schema?.properties?.routes?.properties) {
        const routeIds = Object.keys(schema.properties.routes.properties);
        const routes: Record<string, number> = {};
        routeIds.forEach((routeId: string, index: number) => {
          routes[routeId] = 80 - (index * 10);
        });
        return {
          message: "Routing",
          metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
          structured: { context: "test", routes, responseDirectives: [] },
        };
      }

      // Handle step selection
      if (schema?.properties?.selectedStepId) {
        const stepIds = schema.properties.selectedStepId?.enum || [];
        return {
          message: "Step selection",
          metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
          structured: { reasoning: "test", selectedStepId: stepIds[0] },
        };
      }

      // Handle data extraction / pre-extraction
      if (schemaName.includes('extraction') || schemaName.includes('data')) {
        return {
          message: "",
          metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
          structured: {},
        };
      }

      // Route response — NO tool calls, just structured data with name
      if (schemaName === 'response_output' || schema?.properties?.message) {
        return {
          message: "Your name is Alice.",
          metadata: { model: "mock", tokensUsed: 50, finishReason: "stop" },
          structured: {
            message: "Your name is Alice.",
            name: "Alice",
          },
        };
      }

      return {
        message: "Hello",
        metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
        structured: { message: "Hello" },
      };
    };

    const agent = new Agent<unknown, { name?: string; email?: string }>({
      name: "NoToolLoopAgent",
      description: "Tests no-tool-loop preservation",
      provider: noToolProvider,
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
        },
      },
    });

    agent.createRoute({
      title: "Direct Collection",
      description: "Collect data directly without tools",
      when: ["User provides info"],
      requiredFields: ["name"],
      steps: [{ id: "collect_name", prompt: "What is your name?", collect: ["name"] }],
    });

    const result = await agent.chat("My name is Alice");

    // Data should be collected from the original response (no tool loop involved)
    const collectedData = agent.getCollectedData();
    expect(collectedData.name).toBe("Alice");
  });
});

// ─── Preservation: Non-Aborted Signal Completes Normally ────────────────────────

describe("Preservation: Non-aborted signal completes normally", () => {
  /**
   * When a valid AbortSignal is passed but NOT aborted, generation completes normally.
   * This must continue to work regardless of signal propagation fixes.
   *
   * **Validates: Requirement 3.6**
   */
  test("chat() with non-aborted signal completes successfully", async () => {
    const agent = new Agent<unknown, Record<string, unknown>>({
      name: "NonAbortedSignalAgent",
      description: "Tests non-aborted signal preservation",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        additionalProperties: false,
      },
    });

    agent.createRoute({
      title: "Signal Route",
      description: "Route for signal test",
      when: ["User sends message"],
      requiredFields: ["name"],
      steps: [{ id: "step1", prompt: "What is your name?", collect: ["name"] }],
    });

    // Create a signal that is NEVER aborted
    const controller = new AbortController();
    const signal = controller.signal;

    // Should complete normally without throwing
    const result = await agent.chat("Hello", { signal });
    expect(result).toBeDefined();
    expect(result.message).toBeDefined();
    expect(typeof result.message).toBe("string");
  });

  test("stream() with non-aborted signal completes successfully", async () => {
    const agent = new Agent<unknown, Record<string, unknown>>({
      name: "StreamNonAbortedAgent",
      description: "Tests stream non-aborted signal",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        additionalProperties: false,
      },
    });

    agent.createRoute({
      title: "Stream Signal Route",
      description: "Route for stream signal test",
      when: ["User sends message"],
      requiredFields: ["name"],
      steps: [{ id: "step1", prompt: "What is your name?", collect: ["name"] }],
    });

    // Create a signal that is NEVER aborted
    const controller = new AbortController();
    const signal = controller.signal;

    // Should complete normally without throwing
    let lastChunk: any;
    for await (const chunk of agent.stream("Hello", { signal })) {
      lastChunk = chunk;
    }
    expect(lastChunk).toBeDefined();
    expect(lastChunk.done).toBe(true);
  });
});

// ─── Preservation: Persistence Auto-Save ────────────────────────────────────────

describe("Preservation: Persistence auto-save after chat/stream", () => {
  /**
   * After chat()/stream() completes with persistence configured,
   * the session is saved to the adapter.
   *
   * **Validates: Requirement 3.8**
   */
  test("session is saved to persistence adapter after chat()", async () => {
    const adapter = new MemoryAdapter();

    const agent = new Agent<unknown, Record<string, unknown>>({
      name: "PersistenceTestAgent",
      description: "Tests persistence auto-save",
      provider: MockProviderFactory.basic(),
      sessionId: "persist-auto-save-test",
      persistence: { adapter },
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        additionalProperties: false,
      },
    });

    agent.createRoute({
      title: "Persistence Route",
      description: "Route for persistence test",
      when: ["User sends message"],
      requiredFields: ["name"],
      steps: [{ id: "step1", prompt: "What is your name?", collect: ["name"] }],
    });

    await agent.chat("Hello persistence");

    // Session should have been saved to the adapter — verify by loading it
    const savedSession = await adapter.sessionRepository.findById("persist-auto-save-test");
    expect(savedSession).toBeDefined();
    expect(savedSession!.id).toBe("persist-auto-save-test");
  });
});
