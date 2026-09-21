/**
 * The understand call: shortcuts, prompt, envelope, parsing, provider errors.
 *
 * Every test goes through `mockProvider` with a scripted `understand` queue
 * and asserts the call count through `llmCalls` and `provider.calls`.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { UnderstandRequest } from "../src/core/contracts.js";
import { Understand } from "../src/core/Understand.js";
import type { AgentOptions } from "../src/types/agent.js";
import type { GenerateMessageInput } from "../src/types/ai.js";
import { ProviderError } from "../src/types/errors.js";
import type { FieldDefs, Flow } from "../src/types/flow.js";
import type { StructuredSchema } from "../src/types/schema.js";
import type { Run } from "../src/types/session.js";
import { logger } from "../src/utils/logger.js";
import { isStrictSchema } from "./helpers.js";
import { mockProvider, type MockProvider } from "./mock-provider.js";

interface Ctx {
  empresa: string;
}
type Data = Record<string, unknown>;

const fields: FieldDefs = {
  nome: { type: "string", ask: "Pergunte o nome de um jeito leve." },
  empresa: { type: "string", ask: "Pergunte de qual empresa a pessoa fala." },
  tamanho: { type: "string", enum: ["1-10", "11-50", "51-200", "200+"], ask: "Pergunte quantas pessoas trabalham lá." },
  orcamento: { type: "number", description: "Faixa em reais", ask: "Pergunte a faixa de investimento." },
  confirmado: { type: "boolean", ask: "Resuma e pergunte se está tudo certo." },
};

const triagem: Flow<Ctx, Data> = {
  id: "triagem",
  name: "Triagem",
  description: "Quando alguém chega querendo saber se o produto serve para a empresa dele",
  on: [{ message: ["quer saber como funciona", "pede um orçamento", "quer saber se serve para a empresa"] }],
  steps: [
    { id: "quem", prompt: "Descubra quem é e de onde fala.", collect: ["nome", "empresa"] },
    {
      id: "porte",
      prompt: "Entenda o porte da empresa de {{data.nome}}.",
      collect: ["tamanho", "orcamento"],
      branches: [
        { when: "o cliente quer falar com uma pessoa", then: "end" },
        { when: "o cliente diz que já é cliente", then: "tchau" },
      ],
    },
    { id: "tchau", prompt: "Agradeça." },
  ],
};

const agendar: Flow<Ctx, Data> = {
  id: "agendar",
  name: "Agendar",
  description: "Quando o cliente quer marcar uma reunião",
  on: [{ message: ["quer marcar", "quer remarcar"], repeat: "always" }],
  steps: [{ id: "dia", collect: ["orcamento"] }],
};

const humano: Flow<Ctx, Data> = {
  id: "humano",
  name: "Falar com humano",
  on: [{ message: ["quer falar com uma pessoa"] }],
  steps: [{ id: "avisa", do: "notify", with: { recipient: "owner" } }],
};

const concorrente: Flow<Ctx, Data> = {
  id: "concorrente",
  name: "Lead falou de concorrente",
  on: [
    {
      mention: ["o lead cita ou compara com um concorrente"],
      extract: { trecho: { type: "string", description: "O trecho em que o concorrente aparece" } },
    },
  ],
  steps: [{ id: "tag", do: "add_tags", with: { tags: ["concorrente"] } }],
};

const run: Run = {
  id: "triagem#m1",
  flowId: "triagem",
  anchor: "s1",
  dedupeKey: "triagem:s1:",
  stepId: "porte",
  status: "asking",
  trigger: { kind: "message", key: "m1" },
  hop: 0,
  startedAt: "2026-09-20T10:00:00.000Z",
  asked: {},
  visits: { quem: 1, porte: 1 },
  outcomes: [],
};

const branches: UnderstandRequest["branches"] = [
  { runId: "triagem#m1", stepId: "porte", index: 0, when: "o cliente quer falar com uma pessoa" },
  { runId: "triagem#m1", stepId: "porte", index: 1, when: "o cliente diz que já é cliente" },
];

function request(over: Partial<UnderstandRequest<Ctx, Data>> = {}): UnderstandRequest<Ctx, Data> {
  return {
    text: "oi",
    history: [{ role: "assistant", content: "Oi! Quantas pessoas trabalham aí?" }],
    context: { empresa: "Zeta" },
    data: {},
    messageFlows: [],
    mentionFlows: [],
    branches: [],
    fields: {},
    ...over,
  };
}

/** Floor on triagem's `porte` step, two other message flows, one mention flow, two branches, three fields. */
const full = request({
  text: "pra ontem! a Acme é mais barata, uns 5 mil",
  data: { nome: "João" },
  floor: { run, flow: triagem },
  messageFlows: [agendar, humano],
  mentionFlows: [concorrente],
  branches,
  fields: { empresa: fields.empresa, tamanho: fields.tamanho, orcamento: fields.orcamento },
});

function understand(provider: MockProvider): Understand<Ctx, Data> {
  const options: AgentOptions<Ctx, Data> = {
    name: "Ana",
    persona: "Você fala pela {{context.empresa}}.",
    provider,
    fields,
    knowledgeBase: { horario: "9h-18h" },
    flows: [triagem, agendar, humano, concorrente],
  };
  return new Understand(options);
}

const EMPTY = { flows: {}, mentions: {}, extract: {}, branches: {}, fields: {} };

// The mock gets the schema as `{ [key: string]: unknown }`; the envelope is a StructuredSchema by construction.
const schemaOf = (input: GenerateMessageInput): StructuredSchema => input.parameters?.jsonSchema as StructuredSchema;
const keysOf = (input: GenerateMessageInput, section: string): string[] =>
  Object.keys(schemaOf(input).properties?.[section]?.properties ?? {});

/** Same helper as tests/schema.test.ts: every object is closed and requires all of its properties. */

function leaves(schema: StructuredSchema): StructuredSchema[] {
  const props = Object.values(schema.properties ?? {});
  return props.length ? props.flatMap(leaves) : [schema];
}

const warn = spyOn(logger, "warn");
afterEach(() => warn.mockClear());

describe("Understand shortcuts", () => {
  test("one eligible message flow and no floor starts at 100 with no call", async () => {
    const provider = mockProvider();
    const result = await understand(provider).run(request({ messageFlows: [agendar] }));
    expect(result).toEqual({ ...EMPTY, flows: { agendar: 100 }, llmCalls: 0 });
    expect(provider.calls).toHaveLength(0);
  });

  test("nothing to judge costs no call: no candidates, or only the floor's own flow", async () => {
    const provider = mockProvider();
    const u = understand(provider);
    expect(await u.run(request())).toEqual({ ...EMPTY, llmCalls: 0 });
    expect(await u.run(request({ floor: { run, flow: triagem } }))).toEqual({ ...EMPTY, llmCalls: 0 });
    expect(await u.run(request({ floor: { run, flow: triagem }, messageFlows: [triagem] }))).toEqual({ ...EMPTY, llmCalls: 0 });
    expect(provider.calls).toHaveLength(0);
  });
});

describe("Understand full request", () => {
  test("one call named understand, history passed through", async () => {
    const provider = mockProvider({ understand: [{ flows: {} }] });
    const result = await understand(provider).run(full);
    expect(result.llmCalls).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].input.parameters?.schemaName).toBe("understand");
    expect(provider.calls[0].input.history).toBe(full.history);
    expect(provider.calls[0].input.context).toEqual({ empresa: "Zeta" });
  });

  test("the prompt names every flow, phrase, branch question, field and the message", async () => {
    const provider = mockProvider({ understand: [{ flows: {} }] });
    await understand(provider).run(full);
    const { seen } = provider.calls[0];
    const needles = [
      'You are "Ana"',
      "Você fala pela Zeta.",
      "- horario: 9h-18h",
      // the floor
      '"Triagem" (triagem)',
      "Current step: porte — Entenda o porte da empresa de João.",
      "- tamanho (string) [1-10 | 11-50 | 51-200 | 200+]",
      "- orcamento (number): Faixa em reais",
      '- nome: "João"',
      // candidates, the floor included, with their phrases
      "1. triagem — Triagem: Quando alguém chega",
      "quer saber como funciona; pede um orçamento; quer saber se serve para a empresa",
      "2. agendar — Agendar: Quando o cliente quer marcar uma reunião",
      "quer marcar; quer remarcar",
      "3. humano — Falar com humano",
      "quer falar com uma pessoa",
      "- 90-100: explicit keywords + clear intent",
      "- 0-29: minimal/none",
      // mentions and their extraction
      "- concorrente — Lead falou de concorrente",
      "Counts when: o lead cita ou compara com um concorrente",
      "- trecho (string): O trecho em que o concorrente aparece",
      // branches as questions under safe aliases
      "- q1: o cliente quer falar com uma pessoa",
      "- q2: o cliente diz que já é cliente",
      // anywhere fields
      "Report a value only when the customer actually gave it",
      "- empresa (string)",
      // the message, quoted
      '"""\npra ontem! a Acme é mais barata, uns 5 mil\n"""',
      // the shape restated for prompt-only providers
      '{"flows":{"triagem":0,"agendar":0,"humano":0},"mentions":{"concorrente":false},"extract":{"concorrente":{"trecho":null}},"branches":{"q1":false,"q2":false},"fields":{"empresa":null,"tamanho":null,"orcamento":null}}',
    ];
    for (const needle of needles) expect(seen).toContain(needle);
  });

  test("the envelope is strict, every leaf nullable, every key safe for Gemini", async () => {
    const provider = mockProvider({ understand: [{ flows: {} }] });
    await understand(provider).run(full);
    const schema = schemaOf(provider.calls[0].input);
    expect(isStrictSchema(schema)).toBe(true);
    expect(Object.keys(schema.properties ?? {})).toEqual(["flows", "mentions", "extract", "branches", "fields"]);
    expect(schema.properties?.flows.properties?.triagem.type).toEqual(["integer", "null"]);
    expect(schema.properties?.mentions.properties?.concorrente.type).toEqual(["boolean", "null"]);
    expect(schema.properties?.extract.properties?.concorrente.properties?.trecho.type).toEqual(["string", "null"]);
    expect(schema.properties?.fields.properties?.tamanho.enum).toEqual(["1-10", "11-50", "51-200", "200+"]);
    expect(schema.properties?.fields.properties?.orcamento.type).toEqual(["number", "null"]);
    expect(leaves(schema).every((leaf) => Array.isArray(leaf.type) && leaf.type.includes("null"))).toBe(true);
    for (const leaf of Object.values(schema.properties ?? {})) {
      expect("ask" in leaf).toBe(false);
      for (const key of Object.keys(leaf.properties ?? {})) expect(key).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
    expect(keysOf(provider.calls[0].input, "branches")).toEqual(["q1", "q2"]);
  });

  test("the reply maps back to real ids; nulls are dropped, values stay raw", async () => {
    const provider = mockProvider({
      understand: [
        (input) => {
          const [q1, q2] = keysOf(input, "branches");
          return {
            flows: { triagem: 85, agendar: 20, humano: 5 },
            mentions: { concorrente: true },
            extract: { concorrente: { trecho: "a Acme é mais barata" } },
            branches: { [q1]: true, [q2]: false },
            fields: { empresa: null, tamanho: null, orcamento: "5000" },
          };
        },
      ],
    });
    const result = await understand(provider).run(full);
    expect(result).toEqual({
      flows: { triagem: 85, agendar: 20, humano: 5 },
      mentions: { concorrente: true },
      extract: { concorrente: { trecho: "a Acme é mais barata" } },
      branches: { "triagem#m1/porte/0": true, "triagem#m1/porte/1": false },
      fields: { orcamento: "5000" },
      llmCalls: 1,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("an unsafe flow id is aliased in the envelope and mapped back", async () => {
    const sinal: Flow<Ctx, Data> = { ...concorrente, id: "sinal:concorrente" };
    const provider = mockProvider({
      understand: [(input) => ({ mentions: { [keysOf(input, "mentions")[0]]: true } })],
    });
    const result = await understand(provider).run(request({ mentionFlows: [sinal] }));
    const key = keysOf(provider.calls[0].input, "mentions")[0];
    expect(key).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(key).not.toBe("sinal:concorrente");
    expect(provider.calls[0].prompt).toContain(`- ${key} — Lead falou de concorrente`);
    expect(result.mentions).toEqual({ "sinal:concorrente": true });
  });
});

describe("Understand degraded replies", () => {
  const routing = request({ floor: { run, flow: triagem }, messageFlows: [agendar] });

  test("JSON embedded in a message with no structured envelope is parsed", async () => {
    const provider = mockProvider({ understand: [{ message: 'Claro! {"flows": {"triagem": 90, "agendar": 10}} Pronto.' }] });
    const result = await understand(provider).run(routing);
    expect(result).toEqual({ ...EMPTY, flows: { triagem: 90, agendar: 10 }, llmCalls: 1 });
    expect(warn).not.toHaveBeenCalled();
  });

  test("garbage gives an empty Understanding, one call and one warning", async () => {
    const provider = mockProvider({ understand: [{ message: "não sei dizer" }] });
    const result = await understand(provider).run(routing);
    expect(result).toEqual({ ...EMPTY, llmCalls: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("[Understand]");
  });

  test("string booleans read as booleans; numeric strings as scores; other text is dropped", async () => {
    const provider = mockProvider({
      understand: [
        (input) => ({
          flows: { triagem: "alto", agendar: "30", humano: null },
          mentions: { concorrente: "sim" },
          branches: { [keysOf(input, "branches")[0]]: "yes" },
          extract: { concorrente: "a Acme" },
          fields: "nada",
        }),
      ],
    });
    const result = await understand(provider).run(full);
    expect(result).toEqual({
      flows: { agendar: 30 },
      mentions: { concorrente: true },
      extract: {},
      branches: { "triagem#m1/porte/0": true },
      fields: {},
      llmCalls: 1,
    });
  });

  test("a provider error propagates", async () => {
    const provider = mockProvider({
      understand: [
        () => {
          throw new ProviderError("mock", "overload", "mock: down");
        },
      ],
    });
    await expect(understand(provider).run(routing)).rejects.toBeInstanceOf(ProviderError);
  });
});
