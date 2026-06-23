/**
 * Streaming "tools ran but no text" follow-up (gap a)
 *
 * The non-streaming runLoop forces a final text response when tools execute but
 * the model returns no closing message. This verifies runStreamingBatch now does
 * the same: after executing the tools it generates a result-aware message rather
 * than letting the bare preamble (or an empty message) become the response.
 */
import { expect, test, describe } from "bun:test";

import { Agent, ToolManager, createSession } from "../src/index";
import { ToolLoopExecutor } from "../src/core/ToolLoopExecutor";
import type { AiProvider } from "../src/types/ai";

interface Ctx {
  userId: string;
}
interface Data {
  x?: number;
}

const FORCED_TEXT = "Your order #42 ships tomorrow.";

// The streamed turn is irrelevant here (we drive runStreamingBatch directly);
// only the forced follow-up generateMessage call matters.
const stubProvider: AiProvider = {
  name: "stub",
  capabilities: {
    supportsTools: true,
    supportsNativeJsonSchema: true,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    supportsPromptCaching: false,
  },
  async generateMessage() {
    return { message: FORCED_TEXT, structured: { message: FORCED_TEXT } };
  },
  // eslint-disable-next-line require-yield
  async *generateMessageStream() {
    throw new Error("generateMessageStream is not exercised by this test");
  },
};

describe("runStreamingBatch tools-ran-but-no-text follow-up (gap a)", () => {
  test("forces a closing message from tool results when the model streamed none", async () => {
    const agent = new Agent<Ctx, Data>({
      name: "GapATestAgent",
      description: "Tests the streaming forced-final-text path",
      context: { userId: "u1" },
      provider: stubProvider,
    });

    let executed = false;
    agent.addTool({
      id: "lookup_order",
      description: "Looks up an order",
      handler: async () => {
        executed = true;
        return { status: "shipping", order: 42 };
      },
    });

    const flow = agent.createFlow({
      title: "Orders",
      description: "Order help",
      when: ["order status"],
      steps: [{ id: "ask", prompt: "How can I help with your order?" }],
    });

    const exec = new ToolLoopExecutor<Ctx, Data>({
      toolManager: new ToolManager<Ctx, Data>(agent),
      getAgentOptions: () => agent.getAgentOptions(),
      updateContext: async () => {},
      updateCollectedData: async () => {},
      updateSessionData: async (session, dataUpdate) => ({
        ...session,
        data: { ...session.data, ...dataUpdate },
      }),
    });

    const session = createSession<Data>("gap-a");
    const gen = exec.runStreamingBatch({
      toolCalls: [{ toolName: "lookup_order", arguments: { id: 42 } }],
      context: { userId: "u1" },
      session,
      history: [{ role: "user", content: "where is my order?" }],
      selectedFlow: flow,
      step: flow.initialStep,
      accumulated: "", // the model produced no closing text alongside the tool call
      responsePrompt: "Respond to the user.",
      availableTools: [],
    });

    // Drain progress chunks and capture the generator's return value.
    let finalMessage: string | undefined;
    while (true) {
      const next = await gen.next();
      if (next.done) {
        finalMessage = next.value.finalMessage;
        break;
      }
    }

    expect(executed).toBe(true);
    expect(finalMessage).toBe(FORCED_TEXT);
  });
});

describe("runStreamingBatch multi-round tool loop", () => {
  test("chains a second tool round when the follow-up requests one, then closes with text", async () => {
    const SECOND_TEXT = "Booked: flight, then hotel.";
    let genCalls = 0;
    // Round 1 (tools provided): ask for another tool. Round 2 (no tools): close.
    const provider: AiProvider = {
      name: "stub",
      capabilities: {
        supportsTools: true,
        supportsNativeJsonSchema: true,
        supportsStreaming: true,
        supportsStreamingToolCalls: true,
        supportsPromptCaching: false,
      },
      async generateMessage() {
        genCalls++;
        if (genCalls === 1) {
          return {
            message: "",
            structured: { message: "", toolCalls: [{ toolName: "book_hotel", arguments: {} }] },
          };
        }
        return { message: SECOND_TEXT, structured: { message: SECOND_TEXT } };
      },
      // eslint-disable-next-line require-yield
      async *generateMessageStream() {
        throw new Error("generateMessageStream is not exercised by this test");
      },
    };

    const agent = new Agent<Ctx, Data>({
      name: "MultiRoundAgent",
      description: "Tests streaming multi-round tool loops",
      context: { userId: "u1" },
      provider,
    });

    let flightBooked = false;
    let hotelBooked = false;
    agent.addTool({
      id: "book_flight",
      description: "Books a flight",
      handler: async () => {
        flightBooked = true;
        return { ok: true };
      },
    });
    agent.addTool({
      id: "book_hotel",
      description: "Books a hotel",
      handler: async () => {
        hotelBooked = true;
        return { ok: true };
      },
    });

    const flow = agent.createFlow({
      title: "Travel",
      description: "Travel booking",
      when: ["book travel"],
      steps: [{ id: "ask", prompt: "What trip?" }],
    });

    const exec = new ToolLoopExecutor<Ctx, Data>({
      toolManager: new ToolManager<Ctx, Data>(agent),
      getAgentOptions: () => agent.getAgentOptions(),
      updateContext: async () => {},
      updateCollectedData: async () => {},
      updateSessionData: async (session, dataUpdate) => ({
        ...session,
        data: { ...session.data, ...dataUpdate },
      }),
    });

    const session = createSession<Data>("multi-round");
    const gen = exec.runStreamingBatch({
      toolCalls: [{ toolName: "book_flight", arguments: {} }],
      context: { userId: "u1" },
      session,
      history: [{ role: "user", content: "book a flight and a hotel" }],
      selectedFlow: flow,
      step: flow.initialStep,
      accumulated: "",
      responsePrompt: "Respond to the user.",
      availableTools: [
        { id: "book_flight", name: "book_flight" },
        { id: "book_hotel", name: "book_hotel" },
      ],
    });

    let finalMessage: string | undefined;
    while (true) {
      const next = await gen.next();
      if (next.done) {
        finalMessage = next.value.finalMessage;
        break;
      }
    }

    // The initial batch booked the flight; the follow-up round booked the hotel
    // (a second round — impossible before the streaming/non-streaming tool-engine
    // unification), then the model closed with result-aware text.
    expect(flightBooked).toBe(true);
    expect(hotelBooked).toBe(true);
    expect(finalMessage).toBe(SECOND_TEXT);
    expect(genCalls).toBe(2); // round 1 requests the hotel; round 2 closes with text
  });
});
