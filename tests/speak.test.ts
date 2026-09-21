/**
 * Speak.run: the prompt, the envelope, tool rounds and the fallbacks, against
 * the mock provider.
 */

import { describe, expect, test } from "bun:test";

import { Speak } from "../src/core/Speak.js";
import type { AiProvider, GenerateMessageOutput, GenerateMessageStreamChunk } from "../src/types/ai.js";
import type { Tool } from "../src/types/tool.js";
import { assistantMessage, userMessage } from "../src/utils/history.js";
import { mockProvider } from "./mock-provider.js";
import { type Ctx, type Data, agentOptions, idleRequest, run, talkRequest } from "./speak-fixtures.js";

const nullable = (type: string) => [type, "null"];

const orcamento: Tool<Ctx, Data> = {
  id: "orcamento",
  description: "Calcula o orçamento para o porte informado",
  parameters: { type: "object", properties: { pessoas: { type: "number" } }, required: ["pessoas"] },
  handler: () => ({ value: { total: 1500 }, data: { orcamento: 2500 } }),
};

/** A prompt-only provider that answered twice: prose, then the envelope. No `structured`. */
function looseProvider(text: string): AiProvider {
  return {
    name: "loose",
    capabilities: {
      supportsTools: false,
      supportsNativeJsonSchema: false,
      supportsStreaming: true,
      supportsStreamingToolCalls: false,
      supportsPromptCaching: false,
    },
    generateMessage: <_C, TStructured>() => Promise.resolve<GenerateMessageOutput<TStructured>>({ message: text }),
    async *generateMessageStream<_C, TStructured>(): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
      yield { delta: text, accumulated: text, done: true };
    },
  };
}

describe("Speak.run: talk step", () => {
  test("one call: nullable envelope, guideline, both asks, facts, instructions; history stays out of the prompt", async () => {
    const provider = mockProvider({ speak: [{ message: "Oi! Como você se chama?", nome: null, tamanho: null }] });
    const history = [userMessage("mensagem antiga do cliente"), assistantMessage("resposta antiga da Ana")];
    const out = await new Speak(agentOptions(provider)).run(
      talkRequest({
        history,
        instructions: [{ kind: "never", prompt: "Não invente preços.", when: "o cliente pergunta preço" }],
      }),
    );

    expect(out).toEqual({ spoken: { message: "Oi! Como você se chama?", fields: {}, data: {}, toolCalls: [], llmCalls: 1 } });
    const [call] = provider.calls;
    expect(call.schemaName).toBe("speak");
    expect(call.input.parameters?.jsonSchema).toEqual({
      type: "object",
      properties: {
        message: { type: nullable("string") },
        nome: { type: nullable("string") },
        tamanho: { type: nullable("string"), enum: ["1-10", "11-50"], description: "Pessoas na empresa" },
      },
      required: ["message", "nome", "tamanho"],
      additionalProperties: false,
    });
    expect(call.input.tools).toBeUndefined();

    expect(call.prompt).toContain('You are "Ana"');
    expect(call.prompt).toContain("Você fala pela Acme.");
    expect(call.prompt).toContain("- horario: 9h às 18h");
    expect(call.prompt).toContain("## Flow\nTriagem: Quem chega querendo saber se serve");
    expect(call.prompt).toContain(
      "## Guideline for your reply (adapt to the conversation)\nDescubra quem é e de onde fala, em nome da Acme.",
    );
    expect(call.prompt).toContain("- nome (string)\n  How to ask: Pergunte o nome de um jeito leve.");
    expect(call.prompt).toContain(
      "- tamanho (string) [1-10 | 11-50]: Pessoas na empresa\n  How to ask: Pergunte quantas pessoas trabalham lá; ofereça as faixas.",
    );
    expect(call.prompt).not.toContain("Pergunte o porte.");
    expect(call.prompt).toContain("## Already known");
    expect(call.prompt).toContain("- orcamento: 1500");
    expect(call.prompt).toContain("- [never] [Always] Não invente preços. (apply only when: o cliente pergunta preço)");
    expect(call.prompt).toContain('## Customer\'s latest message\n"quero saber como funciona"');
    expect(call.prompt).toContain('- "nome": nome (string). The value the customer gave, or null when they did not give one.');

    expect(call.input.history).toEqual(history);
    expect(call.prompt).not.toContain("mensagem antiga do cliente");
    expect(call.prompt).not.toContain("resposta antiga da Ana");
  });

  test("a wake adds the you-speak-first line; a message quotes the text", async () => {
    const provider = mockProvider({ speak: [{ message: "Oi, tudo bem?" }, { message: "Oi!" }] });
    const speak = new Speak(agentOptions(provider));
    await speak.run(talkRequest({ input: { kind: "wake" } }));
    await speak.run(talkRequest({ input: { kind: "message", text: "  oi, sou o João  " } }));

    expect(provider.calls[0].prompt).toContain(
      "There is no new message from the customer. You speak first: open naturally, do not answer a question nobody asked.",
    );
    expect(provider.calls[0].prompt).not.toContain("Customer's latest message");
    expect(provider.calls[1].prompt).toContain('## Customer\'s latest message\n"oi, sou o João"');
    expect(provider.calls[1].prompt).not.toContain("You speak first");
  });

  test("a slug Gemini rejects rides under an alias and maps back; a slug without a definition is a string", async () => {
    const provider = mockProvider({ speak: [{ message: "Anotado!", field_0: "João da Silva", nome: null }] });
    const out = await new Speak(agentOptions(provider)).run(talkRequest({ pending: ["nome completo", "nome"] }));

    expect(provider.calls[0].input.parameters?.jsonSchema).toMatchObject({
      properties: { field_0: { type: nullable("string") } },
      required: ["message", "field_0", "nome"],
    });
    expect(provider.calls[0].prompt).toContain('- "field_0": nome completo (string).');
    expect(out).toMatchObject({ spoken: { fields: { "nome completo": "João da Silva" } } });
  });

  test("values come back raw with nulls dropped; stray text around the envelope is tolerated", async () => {
    const provider = looseProvider('Claro!\n{"message":"Prazer, João!","nome":"João","tamanho":"30"}');
    const out = await new Speak(agentOptions(provider)).run(talkRequest());
    expect(out).toEqual({
      spoken: { message: "Prazer, João!", fields: { nome: "João", tamanho: "30" }, data: {}, toolCalls: [], llmCalls: 1 },
    });
  });
});

describe("Speak.run: idle", () => {
  test("envelope is { message } only and the idle prompt is the guideline", async () => {
    const provider = mockProvider({ speak: [{ message: "De nada! Qualquer coisa, é só chamar." }] });
    const out = await new Speak(agentOptions(provider)).run(idleRequest({ instructions: [{ prompt: "Seja breve." }] }));

    expect(out).toEqual({
      spoken: { message: "De nada! Qualquer coisa, é só chamar.", fields: {}, data: {}, toolCalls: [], llmCalls: 1 },
    });
    const [call] = provider.calls;
    expect(call.input.parameters?.jsonSchema).toEqual({
      type: "object",
      properties: { message: { type: nullable("string") } },
      required: ["message"],
      additionalProperties: false,
    });
    expect(call.prompt).toContain(
      "## Guideline for your reply (adapt to the conversation)\nResponda pela empresa; não invente preços.",
    );
    expect(call.prompt).toContain("- [should] [Always] Seja breve.");
    expect(call.prompt).not.toContain("## Flow");
    expect(call.prompt).not.toContain("## Still to collect");
    expect(call.prompt).not.toContain("Rules for the field properties");
  });
});

describe("Speak.run: tool rounds", () => {
  test("runs the tool, feeds the result back, merges data and envelope values last-wins", async () => {
    const seen: unknown[] = [];
    const tool: Tool<Ctx, Data> = {
      ...orcamento,
      handler: (args, ctx) => {
        seen.push(args, ctx);
        return { value: { total: 1500 }, data: { orcamento: 2500 } };
      },
    };
    const provider = mockProvider({
      speak: [
        {
          message: "Deixa eu calcular.",
          toolCalls: [{ toolName: "orcamento", arguments: { pessoas: 30 } }],
          nome: "João",
          tamanho: "1-10",
        },
        { message: "Fica em R$ 1.500. Fechado?", nome: null, tamanho: "11-50" },
      ],
    });
    const out = await new Speak(agentOptions(provider)).run(talkRequest({ tools: [tool] }));

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].input.tools).toEqual([
      { id: "orcamento", name: "orcamento", description: orcamento.description, parameters: orcamento.parameters },
    ]);
    expect(provider.calls[0].prompt).toContain("## Tools");
    expect(provider.calls[1].input.tools).toEqual(provider.calls[0].input.tools);
    expect(provider.calls[1].input.history).toEqual([
      {
        role: "assistant",
        content: "Deixa eu calcular.",
        tool_calls: [{ id: "call-0-0", name: "orcamento", arguments: { pessoas: 30 } }],
      },
      { role: "tool", tool_call_id: "call-0-0", name: "orcamento", content: '{"total":1500}' },
    ]);
    expect(seen[0]).toEqual({ pessoas: 30 });
    expect(seen[1]).toMatchObject({ context: { empresa: "Acme" }, data: { orcamento: 1500 }, history: [], run });
    expect(out).toEqual({
      spoken: {
        message: "Fica em R$ 1.500. Fechado?",
        fields: { nome: "João", tamanho: "11-50" },
        data: { orcamento: 2500 },
        toolCalls: [{ toolName: "orcamento", arguments: { pessoas: 30 } }],
        llmCalls: 2,
      },
    });
  });

  test("a throwing handler becomes an error result the model sees; the turn still ends with a message", async () => {
    const tool: Tool<Ctx, Data> = {
      ...orcamento,
      handler: () => {
        throw new Error("planilha fora do ar");
      },
    };
    const provider = mockProvider({
      speak: [
        { toolCalls: [{ toolName: "orcamento", arguments: { pessoas: 30 } }] },
        { message: "Não consegui calcular agora; te mando em seguida." },
      ],
    });
    const out = await new Speak(agentOptions(provider)).run(talkRequest({ tools: [tool] }));

    expect(provider.calls[1].input.history).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "call-0-0", name: "orcamento", arguments: { pessoas: 30 } }] },
      { role: "tool", tool_call_id: "call-0-0", name: "orcamento", content: '{"error":"planilha fora do ar"}' },
    ]);
    expect(out).toMatchObject({ spoken: { message: "Não consegui calcular agora; te mando em seguida.", llmCalls: 2 } });
  });

  test("validateInput false, a denied permission and an unknown tool skip the handler; string arguments parse", async () => {
    let ran = 0;
    const gated: Tool<Ctx, Data> = {
      id: "gated",
      handler: () => {
        ran++;
        return { value: "ok" };
      },
      validateInput: (args) =>
        typeof args.pessoas === "number"
          ? { valid: true }
          : { valid: false, error: "pessoas must be a number", correctedInput: { pessoas: 0 } },
      checkPermissions: (args) => (args.pessoas === 13 ? { allowed: false, reason: "unlucky" } : { allowed: true }),
    };
    const provider = mockProvider({
      speak: [
        {
          toolCalls: [
            { toolName: "gated", arguments: { pessoas: "trinta" } },
            { toolName: "gated", arguments: { pessoas: 13 } },
            { toolName: "gated", arguments: '{"pessoas":30}' },
            { toolName: "sumida", arguments: {} },
          ],
        },
        { message: "Pronto." },
      ],
    });
    const out = await new Speak(agentOptions(provider)).run(talkRequest({ tools: [gated] }));

    expect(ran).toBe(1);
    expect(provider.calls[1].input.history.filter((h) => h.role === "tool").map((h) => h.content)).toEqual([
      '{"error":"Validation failed: pessoas must be a number","correctedInput":{"pessoas":0}}',
      '{"error":"Permission denied: unlucky"}',
      "ok",
      '{"error":"Tool \\"sumida\\" is not available."}',
    ]);
    expect(out).toMatchObject({
      spoken: {
        toolCalls: [
          { toolName: "gated", arguments: { pessoas: "trinta" } },
          { toolName: "gated", arguments: { pessoas: 13 } },
          { toolName: "gated", arguments: { pessoas: 30 } },
          { toolName: "sumida", arguments: {} },
        ],
      },
    });
  });

  test("a long result is cut at maxResultSizeChars with a notice", async () => {
    const tool: Tool<Ctx, Data> = { id: "longa", maxResultSizeChars: 10, handler: () => ({ value: "x".repeat(30) }) };
    const provider = mockProvider({ speak: [{ toolCalls: [{ toolName: "longa", arguments: {} }] }, { message: "Pronto." }] });
    await new Speak(agentOptions(provider)).run(talkRequest({ tools: [tool] }));
    expect(provider.calls[1].input.history[1]).toMatchObject({
      role: "tool",
      content: `${"x".repeat(10)}\n[truncated: 30 chars total, showing the first 10]`,
    });
  });

  test("concurrency-safe calls run together; the rest run alone, in order", async () => {
    const order: string[] = [];
    const slow = (id: string, safe: boolean): Tool<Ctx, Data> => ({
      id,
      isConcurrencySafe: () => safe,
      handler: async () => {
        order.push(`${id}:start`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`${id}:end`);
        return { value: id };
      },
    });
    const provider = mockProvider({
      speak: [
        { toolCalls: [{ toolName: "a", arguments: {} }, { toolName: "b", arguments: {} }, { toolName: "c", arguments: {} }] },
        { message: "Feito." },
      ],
    });
    await new Speak(agentOptions(provider)).run(talkRequest({ tools: [slow("a", true), slow("b", true), slow("c", false)] }));
    expect(order).toEqual(["a:start", "b:start", "a:end", "b:end", "c:start", "c:end"]);
  });

  test("maxToolLoops 0 never passes tools", async () => {
    const provider = mockProvider({ speak: [{ message: "Oi!" }] });
    await new Speak(agentOptions(provider, { maxToolLoops: 0 })).run(talkRequest({ tools: [orcamento] }));
    expect(provider.calls[0].input.tools).toBeUndefined();
    expect(provider.calls[0].prompt).not.toContain("## Tools");
  });

  test("the loop cap forces a final call without tools", async () => {
    const provider = mockProvider({
      speak: [
        { toolCalls: [{ toolName: "orcamento", arguments: { pessoas: 10 } }] },
        { toolCalls: [{ toolName: "orcamento", arguments: { pessoas: 20 } }] },
        { message: "Fechado em R$ 1.500." },
      ],
    });
    const out = await new Speak(agentOptions(provider, { maxToolLoops: 2 })).run(talkRequest({ tools: [orcamento] }));

    expect(provider.calls.map((c) => c.input.tools === undefined)).toEqual([false, false, true]);
    expect(provider.calls[2].prompt).toContain("Do not call any tools.");
    expect(provider.calls[2].input.history).toHaveLength(4);
    expect(out).toMatchObject({
      spoken: {
        message: "Fechado em R$ 1.500.",
        llmCalls: 3,
        toolCalls: [
          { toolName: "orcamento", arguments: { pessoas: 10 } },
          { toolName: "orcamento", arguments: { pessoas: 20 } },
        ],
      },
    });
  });
});

describe("Speak.run: fallbacks", () => {
  test("a provider failure on the first round defers", async () => {
    const provider = mockProvider();
    const out = await new Speak(agentOptions(provider)).run(talkRequest());
    expect(out).toEqual({ deferred: "provider-unavailable", llmCalls: 1 });
  });

  test("a provider failure on a tool follow-up round defers with both calls counted", async () => {
    const provider = mockProvider({ speak: [{ toolCalls: [{ toolName: "orcamento", arguments: { pessoas: 30 } }] }] });
    const out = await new Speak(agentOptions(provider)).run(talkRequest({ tools: [orcamento] }));
    expect(out).toEqual({ deferred: "provider-unavailable", llmCalls: 2 });
  });

  test("an empty message defers", async () => {
    const provider = mockProvider({ speak: [{ message: "   " }] });
    const out = await new Speak(agentOptions(provider)).run(talkRequest());
    expect(out).toEqual({ deferred: "provider-unavailable", llmCalls: 1 });
  });
});
