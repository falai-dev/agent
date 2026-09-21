/**
 * What a turn cost.
 *
 * `llmCalls` says how many calls a turn spent; `usage` says what they cost.
 * A text turn spends two, a tool round adds one, and the host bills the
 * conversation — so the framework adds them up instead of leaving the counts
 * buried inside two phases the host never sees.
 */

import { describe, expect, test } from "bun:test";

import type { Tool } from "../src/index.js";
import type { Ctx, Data } from "./scenarios/fixture.js";
import { build, message, spoken, suporte, triagem, understood } from "./scenarios/fixture.js";
import type { MockCall } from "./mock-provider.js";

const faq: Tool<Ctx, Data> = {
  id: "faq",
  description: "Busca uma resposta na base de perguntas frequentes.",
  parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  handler: () => ({ value: "Custa R$ 10 por mês." }),
};

/** What the mock charged one call to read: its system half plus its turn half. */
const read = (call: MockCall): number => (call.system?.length ?? 0) + call.prompt.length;

describe("TurnResult.usage", () => {
  test("a text turn adds up both of its calls", async () => {
    const { agent, provider } = build([triagem, suporte], {
      usage: true,
      script: {
        understand: [understood({ flows: { triagem: 92, suporte: 8 } })],
        speak: [spoken("Oi! Com quem eu falo, e de qual empresa?")],
      },
    });

    const r = await agent.turn(message("oi, quero saber como funciona", "m1"));
    expect(r.llmCalls).toBe(2);
    expect(provider.calls.map((c) => c.schemaName)).toEqual(["understand", "speak"]);

    // The mock charges characters: what each call read, and what it wrote.
    expect(r.usage).toEqual({
      promptTokens: provider.calls.reduce((n, c) => n + read(c), 0),
      completionTokens: expect.any(Number),
      cachedInputTokens: 0,
    });
    // Two calls, not one counted twice: the understand call alone read less.
    expect(r.usage!.promptTokens).toBeGreaterThan(read(provider.calls[0]));
  });

  test("a tool round is billed too", async () => {
    const { agent, provider } = build([], {
      usage: true,
      tools: [faq],
      idle: { prompt: "Responda pela empresa." },
      script: { speak: [{ message: "", toolCalls: [{ toolName: "faq", arguments: { q: "preço" } }] }, spoken("Custa R$ 10 por mês.")] },
    });

    const r = await agent.turn(message("quanto custa?", "m1"));
    expect(r.llmCalls).toBe(2);
    expect(provider.calls).toHaveLength(2);
    expect(r.usage!.promptTokens).toBe(provider.calls.reduce((n, c) => n + read(c), 0));
  });

  test("a turn that spends no call has nothing to report", async () => {
    const { agent } = build([], { usage: true, idle: "silent" });
    const r = await agent.turn(message("oi", "m1"));
    expect(r.llmCalls).toBe(0);
    expect(r.usage).toBeUndefined();
  });

  test("a provider that counts nothing reports nothing — zero would be a lie", async () => {
    const { agent } = build([], {
      idle: { prompt: "Responda pela empresa." },
      script: { speak: [spoken("Oi!")] },
    });
    const r = await agent.turn(message("oi", "m1"));
    expect(r.llmCalls).toBe(1);
    expect(r.usage).toBeUndefined();
  });
});
