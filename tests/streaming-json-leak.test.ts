/**
 * Streaming structured-JSON leak (#2) — end to end.
 *
 * Real providers stream the raw JSON wrapper (`{"message":"..."}`) under a JSON
 * schema; the default test mock streams plain text, which hides the leak. This
 * suite drives a faithful JSON-fragment-streaming provider through the public
 * `stream()` API and asserts that:
 *   - streamed deltas/accumulated are clean message text (never raw JSON),
 *   - the assistant message stored in history is clean (not raw JSON),
 *   - flow required/optional fields are collected from the streamed structured
 *     even when the step declares no `collect`.
 */
import { expect, test, describe } from "bun:test";

import { Agent } from "../src/index";
import { MockProvider } from "./mock-provider";
import type {
  AgentStructuredResponse,
  GenerateMessageInput,
  GenerateMessageStreamChunk,
} from "../src/types/ai";

/**
 * A MockProvider that streams the *raw JSON wrapper* of its structured response
 * in small fragments — exactly how Gemini/OpenAI/Anthropic behave under a JSON
 * schema. Routing/step-selection still use MockProvider's non-streaming logic.
 */
class JsonStreamProvider extends MockProvider {
  constructor(private readonly streamStructured: AgentStructuredResponse) {
    super({
      responseMessage: String(streamStructured.message ?? ""),
      structuredResponse: streamStructured,
    });
  }

  async *generateMessageStream<TContext = unknown, TStructured = AgentStructuredResponse>(
    _input: GenerateMessageInput<TContext>
  ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
    const json = JSON.stringify(this.streamStructured);
    // Tiny fragments so token boundaries fall mid-key and mid-value.
    const size = 3;
    let accumulated = "";
    for (let i = 0; i < json.length; i += size) {
      const delta = json.slice(i, i + size);
      accumulated += delta;
      const done = i + size >= json.length;
      // justification: the mock yields the framework's own structured shape; the
      // generic TStructured is erased at the test boundary.
      yield {
        delta,
        accumulated,
        done,
        metadata: { model: "json-mock", tokensUsed: 1, finishReason: done ? "stop" : undefined },
        ...(done ? { structured: this.streamStructured as unknown as TStructured } : {}),
      } as GenerateMessageStreamChunk<TStructured>;
    }
  }
}

interface Ctx {
  userId: string;
}
interface Data {
  email?: string;
}

function buildAgent(structured: AgentStructuredResponse) {
  const agent = new Agent<Ctx, Data>({
    name: "SignupAgent",
    description: "Collects an email",
    context: { userId: "u1" },
    provider: new JsonStreamProvider(structured),
  });

  // Flow-level required field, but the step declares NO `collect` — the old
  // streaming path gated collection on `step.collect` and would drop it.
  agent.createFlow({
    title: "Signup",
    description: "Sign the user up",
    when: ["sign up", "register"],
    requiredFields: ["email"],
    steps: [{ id: "ask", prompt: "What's your email?" }],
  });

  return agent;
}

describe("streaming structured-JSON leak (#2)", () => {
  test("emits clean message deltas/accumulated — never raw JSON", async () => {
    const agent = buildAgent({ message: "Got it, thanks!", email: "a@b.com" });

    const deltas: string[] = [];
    let finalAccumulated = "";
    for await (const chunk of agent.stream("I want to sign up")) {
      deltas.push(chunk.delta);
      finalAccumulated = chunk.accumulated;
      // No chunk may leak JSON structure.
      expect(chunk.accumulated).not.toContain('{"');
      expect(chunk.accumulated).not.toContain('"message"');
      expect(chunk.delta).not.toContain('"message"');
    }

    // Deltas concatenate to the clean message, and the final accumulated is it.
    expect(deltas.join("")).toBe("Got it, thanks!");
    expect(finalAccumulated).toBe("Got it, thanks!");
  });

  test("stores the clean message in history (not the raw JSON wrapper)", async () => {
    const agent = buildAgent({ message: "Welcome aboard!", email: "a@b.com" });

    // Drain the stream.
    for await (const _ of agent.stream("sign me up")) {
      void _;
    }

    const history = agent.session.getHistory();
    const assistantTurns = history.filter((h) => h.role === "assistant");
    expect(assistantTurns.length).toBeGreaterThan(0);
    const last = assistantTurns[assistantTurns.length - 1];
    expect(last.content).toBe("Welcome aboard!");
    expect(last.content).not.toContain('{"');
  });

  test("collects flow required fields from the streamed structured without a step `collect`", async () => {
    const agent = buildAgent({ message: "Got it!", email: "user@example.com" });

    for await (const _ of agent.stream("register me")) {
      void _;
    }

    // The email is a flow requiredField (not a step.collect target) — the fix
    // makes the streaming path harvest it like the non-streaming path does.
    expect(agent.getCollectedData().email).toBe("user@example.com");
  });
});
