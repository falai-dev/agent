/**
 * Structured generations on the Responses-API path (OpenAI, OpenRouter) must
 * carry the full conversation: history mapped onto input items plus the prompt
 * as the final user turn. Regression test for the `input: ""` bug that made
 * every structured turn amnesiac.
 */
import { describe, expect, test } from "bun:test";

import {
  createOpenAICompatibleProvider,
} from "../src/providers/GenericOpenAICompatibleProvider";
import type { GenerateMessageInput } from "../src/types/ai";
import type { HistoryItem } from "../src/types/history";

describe("executeStructuredGenerate carries conversation context", () => {
  test("history maps to input items and the prompt is the final user turn", async () => {
    const provider = createOpenAICompatibleProvider({
      name: "stub",
      baseURL: "http://localhost/v1",
      apiKey: "k",
      model: "stub-model",
      // Route through the Responses-API path (the OpenAI/OpenRouter default)
      // so the real executeStructuredGenerate implementation runs.
      structuredOutput: "responses_parse",
    });

    let captured: Record<string, unknown> | undefined;
    (
      provider as unknown as {
        client: { responses: { parse: unknown } };
      }
    ).client = {
      responses: {
        parse: async (params: Record<string, unknown>) => {
          captured = params;
          return {
            output_parsed: { message: "ok" },
            model: "stub-model",
            usage: {},
          };
        },
      },
    };

    const history: HistoryItem[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "earlier question" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", name: "get_weather", arguments: { city: "Paris" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "get_weather", content: '{"temp":21}' },
    ];

    const input: GenerateMessageInput<undefined> = {
      prompt: "now summarize",
      history,
      context: undefined,
      parameters: { jsonSchema: { type: "object" } },
    };

    const result = await provider.generateMessage(input);
    expect(result.message).toBe("ok");

    expect(captured).toBeDefined();
    // The old bug: instructions carried the prompt and input was an empty string.
    expect(captured?.input).not.toBe("");
    expect(captured?.instructions).toBeUndefined();

    const items = captured?.input as Array<Record<string, unknown>>;
    expect(items.at(-1)).toEqual({ role: "user", content: "now summarize" });
    expect(items).toContainEqual({ role: "system", content: "be brief" });
    expect(items).toContainEqual({ role: "user", content: "earlier question" });

    // Tool exchanges map onto function_call / function_call_output pairs keyed
    // by the original ids — so post-tool follow-ups can see the tool results.
    expect(items).toContainEqual({
      type: "function_call",
      call_id: "call_1",
      name: "get_weather",
      arguments: '{"city":"Paris"}',
    });
    expect(items).toContainEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: '{"temp":21}',
    });
  });
});
