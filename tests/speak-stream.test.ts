/**
 * Speak.stream: clean message deltas out of a streamed JSON envelope, tool
 * rounds mid-stream, and the same outcome `run()` gives.
 */

import { describe, expect, test } from "bun:test";

import type { SpeakOutcome, SpeakStreamChunk } from "../src/core/contracts.js";
import { Speak } from "../src/core/Speak.js";
import type { GenerateMessageInput, GenerateMessageStreamChunk } from "../src/types/ai.js";
import type { Tool } from "../src/types/tool.js";
import { type MockProvider, type Scripted, mockProvider } from "./mock-provider.js";
import { type Ctx, type Data, agentOptions, talkRequest } from "./speak-fixtures.js";

/**
 * The mock, streaming the way a real adapter does: the raw JSON envelope in
 * small pieces, `accumulated` growing, `structured` only on the final chunk.
 */
function jsonStreamProvider(script: Scripted[]): MockProvider {
  const mock = mockProvider({ speak: script });
  return {
    ...mock,
    async *generateMessageStream<C, TStructured>(
      input: GenerateMessageInput<C>,
    ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
      const out = await mock.generateMessage<C, TStructured>(input);
      const text = JSON.stringify(out.structured);
      let accumulated = "";
      for (let i = 0; i < text.length; i += 4) {
        const delta = text.slice(i, i + 4);
        accumulated += delta;
        yield { delta, accumulated, done: false };
      }
      yield { delta: "", accumulated: text, done: true, structured: out.structured };
    },
  };
}

async function collect(stream: AsyncIterable<SpeakStreamChunk>): Promise<{ deltas: string[]; outcome: SpeakOutcome }> {
  const deltas: string[] = [];
  let outcome: SpeakOutcome | undefined;
  for await (const chunk of stream) {
    if ("delta" in chunk) deltas.push(chunk.delta);
    else outcome = chunk.outcome;
  }
  if (!outcome) throw new Error("stream ended without a done chunk");
  return { deltas, outcome };
}

const reply = {
  message: "Oi, João! Bem-vindo à Acme.\nMe conta: quantas pessoas trabalham aí?",
  nome: "João",
  tamanho: null,
};

describe("Speak.stream", () => {
  test("deltas carry only message text and add up to the final message", async () => {
    const provider = jsonStreamProvider([reply]);
    const { deltas, outcome } = await collect(new Speak(agentOptions(provider)).stream(talkRequest()));

    expect(deltas.length).toBeGreaterThan(1);
    for (const delta of deltas) {
      expect(delta).not.toContain("{");
      expect(delta).not.toContain('"message"');
      expect(delta).not.toContain("nome");
      expect(delta).not.toContain("tamanho");
    }
    expect(deltas.join("")).toBe(reply.message);
    expect(outcome).toEqual({
      spoken: { message: reply.message, fields: { nome: "João" }, data: {}, llmCalls: 1 },
    });
  });

  test("fields streamed before the message are skipped, not leaked", async () => {
    const provider = jsonStreamProvider([{ nome: "João", tamanho: null, message: reply.message }]);
    const { deltas } = await collect(new Speak(agentOptions(provider)).stream(talkRequest()));
    expect(deltas.join("")).toBe(reply.message);
    for (const delta of deltas) expect(delta).not.toMatch(/[{}"]/);
  });

  test("the done chunk carries the outcome run() gives", async () => {
    const [a, b] = [jsonStreamProvider([reply]), jsonStreamProvider([reply])];
    const streamed = await collect(new Speak(agentOptions(a)).stream(talkRequest()));
    const ran = await new Speak(agentOptions(b)).run(talkRequest());

    expect(streamed.outcome).toEqual(ran);
    expect(a.calls[0].prompt).toBe(b.calls[0].prompt);
    expect(a.calls[0].input.parameters).toEqual(b.calls[0].input.parameters);
  });

  test("a tool call mid-stream runs the tool and streams the follow-up round", async () => {
    const tool: Tool<Ctx, Data> = { id: "orcamento", handler: () => ({ value: { total: 1500 }, data: { orcamento: 1500 } }) };
    const provider = jsonStreamProvider([
      { toolCalls: [{ toolName: "orcamento", arguments: { pessoas: 30 } }] },
      { message: "Fica em R$ 1.500.", nome: null, tamanho: "11-50" },
    ]);
    const { deltas, outcome } = await collect(new Speak(agentOptions(provider)).stream(talkRequest({ tools: [tool] })));

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].input.history).toEqual([
      { role: "user", content: "quero saber como funciona" },
      { role: "assistant", content: null, tool_calls: [{ id: "call-0-0", name: "orcamento", arguments: { pessoas: 30 } }] },
      { role: "tool", tool_call_id: "call-0-0", name: "orcamento", content: '{"total":1500}' },
    ]);
    expect(deltas.join("")).toBe("Fica em R$ 1.500.");
    expect(outcome).toEqual({
      spoken: {
        message: "Fica em R$ 1.500.",
        fields: { tamanho: "11-50" },
        data: { orcamento: 1500 },
        llmCalls: 2,
      },
    });
  });

  test("a provider failure ends the stream with a deferred outcome", async () => {
    const provider = jsonStreamProvider([]);
    const { deltas, outcome } = await collect(new Speak(agentOptions(provider)).stream(talkRequest()));
    expect(deltas).toEqual([]);
    expect(outcome).toEqual({ deferred: { code: "provider-unavailable", retryable: true }, llmCalls: 1 });
  });

  test("a plain-text stream passes through as one delta", async () => {
    const provider = mockProvider({ speak: [{ message: "Oi!" }] });
    const { deltas, outcome } = await collect(new Speak(agentOptions(provider)).stream(talkRequest()));
    expect(deltas).toEqual(["Oi!"]);
    expect(outcome).toMatchObject({ spoken: { message: "Oi!", llmCalls: 1 } });
  });
});
