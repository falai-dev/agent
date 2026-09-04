/**
 * Agent-level `maxToolLoops` option
 *
 * The tool loop cap used to be hardcoded to 5 inside ToolLoopExecutor. The
 * option is now exposed on AgentOptions and wired through Agent → ResponseModal
 * → ToolLoopExecutor, so `createAgent({ maxToolLoops: N })` (or the default 5)
 * bounds how many tool rounds a single turn may run.
 */
import { expect, test, describe } from "bun:test";

import { Agent } from "../src/index.js";
import { MockProvider } from "./mock-provider.js";

interface TestData {
  name?: string;
}

/**
 * Provider where the flow-response call ALWAYS requests another tool call,
 * so the loop only stops when the cap is hit.
 */
function createAlwaysToolCallsProvider(onToolResponse: () => void): MockProvider {
  const provider = new MockProvider();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).generateMessage = async (input: any) => {
    const schema = input.parameters?.jsonSchema as any;
    const schemaName = (input.parameters?.schemaName as string) || "";

    // Routing call
    if (schema?.properties?.flows?.properties) {
      const flowIds = Object.keys(schema.properties.flows.properties);
      const flows: Record<string, number> = {};
      flowIds.forEach((flowId, index) => {
        flows[flowId] = 80 - index * 10;
      });
      return {
        message: "Routing",
        metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
        structured: { context: "test", flows, responseDirectives: [] },
      };
    }

    // Step selection call
    if (schema?.properties?.selectedStepId) {
      const stepIds = schema.properties.selectedStepId?.enum || [];
      return {
        message: "Step selection",
        metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
        structured: { reasoning: "test", selectedStepId: stepIds[0] },
      };
    }

    // Data extraction calls
    if (schemaName.includes("extraction") || schemaName.includes("data")) {
      return {
        message: "",
        metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
        structured: {},
      };
    }

    // Flow response and follow-up calls: always request another tool call
    if (schemaName === "response_output" || schemaName === "tool_followup") {
      onToolResponse();
      return {
        message: "Calling the tool again.",
        metadata: { model: "mock", tokensUsed: 50, finishReason: "stop" },
        structured: {
          message: "Calling the tool again.",
          toolCalls: [{ toolName: "ping", arguments: {} }],
        },
      };
    }

    return {
      message: "Hello",
      metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
      structured: { message: "Hello" },
    };
  };
  return provider;
}

function createAgentWithToolLoop(maxToolLoops?: number) {
  let toolExecutions = 0;
  const provider = createAlwaysToolCallsProvider(() => {});

  const agent = new Agent<unknown, TestData>({
    name: "MaxToolLoopsAgent",
    provider,
    maxToolLoops,
  });

  agent.addTool({
    id: "ping",
    description: "Counts executions",
    handler: async () => {
      toolExecutions++;
      return { ok: true };
    },
  });

  agent.createFlow({
    title: "Ping",
    description: "Ping flow",
    when: ["User wants to ping"],
    steps: [{ id: "ask", prompt: "Say hi." }],
  });

  return { agent, getToolExecutions: () => toolExecutions };
}

describe("AgentOptions.maxToolLoops", () => {
  test("caps the tool loop at the configured value", async () => {
    const { agent, getToolExecutions } = createAgentWithToolLoop(2);

    await agent.chat("ping");

    // The initial tool batch executes once before the loop; the loop then runs
    // up to maxToolLoops follow-up rounds, each executing the tool once more.
    expect(getToolExecutions()).toBe(3);
  });

  test("defaults to 5 when not configured", async () => {
    const { agent, getToolExecutions } = createAgentWithToolLoop();

    await agent.chat("ping");

    expect(getToolExecutions()).toBe(6);
  });
});
