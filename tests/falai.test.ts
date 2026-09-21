/**
 * The factory: value-level inference and the shell it builds.
 *
 * Type assertions here run under `bun run typecheck` (tsconfig.test.json);
 * the runtime assertions run under `bun test`.
 */

import { describe, expect, test } from "bun:test";

import { Agent, falai, NotImplementedError } from "../src/index.js";
import type { DataOf, InferData, InferParams } from "../src/index.js";
import { mockProvider } from "./mock-provider.js";

interface LeadContext {
  lead: { id: string; tags: string[]; owner: "ai" | "human" };
}

const f = falai<LeadContext>().fields({
  nome: { type: "string", ask: "Pergunte o nome de um jeito leve." },
  tamanho: { type: "string", enum: ["1-10", "11-50", "51-200"], ask: "Pergunte quantas pessoas trabalham lá." },
  orcamento: { type: "number", ask: "Pergunte a faixa de investimento." },
  confirmado: { type: "boolean", ask: "Resuma e pergunte se está tudo certo." },
});

type Data = DataOf<typeof f>;

// ── Type-level checks (compile-time) ────────────────────────────────────

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(_ok: T): void => undefined;

assertType<Same<Data["nome"], string>>(true);
assertType<Same<Data["tamanho"], "1-10" | "11-50" | "51-200">>(true);
assertType<Same<Data["orcamento"], number>>(true);
assertType<Same<Data["confirmado"], boolean>>(true);
assertType<Same<Data, InferData<typeof f.fields>>>(true);

type NotifyParams = InferParams<{
  recipient: { type: "string" };
  tags: { type: "array"; items: { type: "string" } };
  urgent: { type: "boolean"; optional: true };
}>;
assertType<Same<NotifyParams["recipient"], string>>(true);
assertType<Same<NotifyParams["tags"], string[]>>(true);
assertType<Same<NotifyParams["urgent"], boolean | undefined>>(true);

const notify = f.action({
  parameters: { recipient: { type: "string" }, message: { type: "string" } },
  run: (params, ctx) => {
    assertType<Same<typeof params, { recipient: string; message: string }>>(true);
    assertType<Same<typeof ctx.context, LeadContext>>(true);
    ctx.set({ nome: "x" });
    // @ts-expect-error unknown field
    ctx.set({ typo: "x" });
    return { ok: true, detail: `${params.recipient}: ${params.message}` };
  },
});

const tagsAny = f.condition((ctx, tags: string[]) => tags.some((t) => ctx.context.lead.tags.includes(t)));

const triagem = f.flow({
  id: "triagem",
  name: "Triagem",
  on: [{ message: ["quer saber como funciona"] }],
  steps: [
    { id: "quem", prompt: "Descubra quem é.", collect: ["nome"] },
    { id: "porte", collect: ["tamanho", "orcamento"], maxAsks: 2 },
    { id: "confirma", collect: ["confirmado"] },
    { id: "ok", if: { equals: { confirmado: true } }, else: { step: "quem", clear: ["confirmado"] } },
    { id: "avisa", do: "notify", with: { recipient: "owner", message: "Lead qualificado: {{data.nome}}" } },
    { id: "espera", wait: "2d", else: "end" },
    { id: "tchau", prompt: "Agradeça." },
  ],
});

f.flow({
  id: "typo",
  name: "Typo",
  // @ts-expect-error 'nome_' is not a field
  steps: [{ id: "a", collect: ["nome_"] }],
});

f.flow({
  id: "typo2",
  name: "Typo",
  // @ts-expect-error 'nome_' is not a field
  clearOnStart: ["nome_"],
  steps: [],
});

// ── Runtime checks ──────────────────────────────────────────────────────

describe("falai()", () => {
  test("binds fields and returns flows unchanged", () => {
    expect(Object.keys(f.fields)).toEqual(["nome", "tamanho", "orcamento", "confirmado"]);
    expect(triagem.steps).toHaveLength(7);
    expect(triagem.id).toBe("triagem");
  });

  test("actions keep their handler; conditions become checkable", async () => {
    const ctx = {
      context: { lead: { id: "l1", tags: ["vip"], owner: "ai" as const } },
      data: {},
      input: undefined,
      run: {
        id: "triagem#m1", flowId: "triagem", anchor: "s1", dedupeKey: "triagem:s1:", stepId: null,
        status: "running" as const, trigger: { kind: "message" as const, key: "m1" }, hop: 0,
        startedAt: "2026-09-20T10:00:00.000Z", asked: {}, visits: {}, outcomes: [],
      },
      now: new Date("2026-09-20T10:00:00.000Z"),
    };
    expect(tagsAny.check(ctx, ["vip"])).toBe(true);
    expect(tagsAny.check(ctx, ["other"])).toBe(false);

    const result = await notify.run(
      { recipient: "owner", message: "oi" },
      { ...ctx, key: "k", dedupeKey: "d", set: () => undefined },
    );
    expect(result).toEqual({ ok: true, detail: "owner: oi" });
  });

  test("agent() builds a shell whose turn is not implemented yet", async () => {
    const agent = f.agent({
      name: "Ana",
      provider: mockProvider(),
      actions: { notify },
      conditions: { tagsAny },
      flows: [triagem],
    });
    expect(agent).toBeInstanceOf(Agent);
    expect(agent.options.fields).toBe(f.fields);
    expect(agent.options.flows).toEqual([triagem]);

    const context: LeadContext = { lead: { id: "l1", tags: [], owner: "ai" } };
    await expect(agent.turn({ sessionId: "s1", context, message: "oi" })).rejects.toBeInstanceOf(NotImplementedError);
  });

  test("falai() without fields still builds an agent", () => {
    const loose = falai().agent({ name: "Ana", provider: mockProvider(), flows: [] });
    expect(loose.options.fields).toEqual({});
  });
});

describe("mockProvider()", () => {
  test("replies per schema name, records calls and fails loudly when dry", async () => {
    const provider = mockProvider({ speak: [{ message: "olá" }] });
    const out = await provider.generateMessage({
      prompt: "p",
      history: [],
      context: undefined,
      parameters: { jsonSchema: {}, schemaName: "speak" },
    });
    expect(out.message).toBe("olá");
    expect(provider.calls.map((c) => c.schemaName)).toEqual(["speak"]);
    expect(provider.remaining()).toEqual({ speak: 0 });
    await expect(
      provider.generateMessage({ prompt: "p", history: [], context: undefined, parameters: { jsonSchema: {}, schemaName: "speak" } }),
    ).rejects.toThrow('no scripted "speak" reply left');
  });
});
