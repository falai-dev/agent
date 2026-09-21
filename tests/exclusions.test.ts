/**
 * `!` phrases rule a trigger out instead of firing it.
 *
 * Every phrase under a trigger is an alternative, so a list alone can only say
 * "any of these". Three products ship signals whose accuracy depends on saying
 * "but not this" — a lead answering "pode sim" to an offer of a meeting is
 * agreeing to the meeting, not asking for a human. Rendered as one more
 * alternative, each of those would become a reason to fire.
 */

import { describe, expect, test } from "bun:test";

import type { UnderstandRequest } from "../src/core/contracts.js";
import { instructionsSection } from "../src/core/Prompt.js";
import { Understand } from "../src/core/Understand.js";
import { validateFlow } from "../src/core/FlowSpec.js";
import type { AgentOptions } from "../src/types/agent.js";
import { FlowConfigurationError } from "../src/types/errors.js";
import type { FieldDefs, Flow } from "../src/types/flow.js";
import { splitPhrases } from "../src/utils/phrases.js";
import { mockProvider, type MockProvider } from "./mock-provider.js";

type Data = Record<string, unknown>;

const fields: FieldDefs = { nome: { type: "string", ask: "Pergunte o nome." } };

/** prospectar's real `pediu_humano` signal, trimmed to one phrase of each sort. */
const humano: Flow<undefined, Data> = {
  id: "pediu_humano",
  name: "Pediu atendimento humano",
  on: [
    {
      mention: [
        "O lead pede explicitamente para falar com um humano",
        "!O lead apenas concorda em agendar (ex.: pode sim, pode marcar)",
      ],
    },
  ],
  steps: [{ id: "avisa", say: "Claro, já chamei alguém da equipe." }],
};

const triagem: Flow<undefined, Data> = {
  id: "triagem",
  name: "Triagem",
  on: [{ message: ["quer um orçamento", "!o cliente só está agradecendo"] }],
  steps: [{ id: "quem", prompt: "Descubra quem é.", collect: ["nome"] }],
};

function request(over: Partial<UnderstandRequest<undefined, Data>> = {}): UnderstandRequest<undefined, Data> {
  return {
    text: "pode sim",
    history: [],
    context: undefined,
    data: {},
    messageFlows: [],
    mentionFlows: [],
    branches: [],
    fields: {},
    ...over,
  };
}

function understand(provider: MockProvider): Understand<undefined, Data> {
  const options: AgentOptions<undefined, Data> = {
    name: "Ana",
    provider,
    fields,
    flows: [triagem, humano],
  };
  return new Understand(options);
}

const registries = { fields, actions: {}, events: {}, conditions: {}, tools: [] };

describe("splitPhrases", () => {
  test("splits on a leading bang and trims both sides", () => {
    expect(splitPhrases(["  pede orçamento ", "!  só agradeceu  "])).toEqual({
      counts: ["pede orçamento"],
      excludes: ["só agradeceu"],
    });
  });

  test("drops blanks and a bare bang rather than emitting an empty rule", () => {
    expect(splitPhrases(["", "   ", "!", "! ", "pede orçamento"])).toEqual({
      counts: ["pede orçamento"],
      excludes: [],
    });
  });

  test("a bang anywhere but the front is ordinary text", () => {
    expect(splitPhrases(["o lead diz agora!"])).toEqual({ counts: ["o lead diz agora!"], excludes: [] });
  });
});

describe("the understand prompt", () => {
  test("a mention's exclusions are told apart from its matches", async () => {
    const provider = mockProvider({ understand: [{ mentions: {} }] });
    await understand(provider).run(request({ mentionFlows: [humano] }));
    const { prompt } = provider.calls[0];

    expect(prompt).toContain("Counts when: O lead pede explicitamente para falar com um humano");
    expect(prompt).toContain("Does not count when: O lead apenas concorda em agendar (ex.: pode sim, pode marcar)");
    expect(prompt).toContain("A 'Does not count when' line overrides a match");
    // The exclusion must never read as one more way to say yes.
    expect(prompt).not.toContain("Counts when: O lead apenas concorda");
  });

  test("a message flow's exclusions become a zero-score rule, not a reason to route", async () => {
    // Two candidates: one eligible message flow with no floor routes without a
    // call, so there would be no prompt to inspect.
    const outro: Flow<undefined, Data> = { id: "outro", name: "Outro", on: [{ message: ["quer outra coisa"] }], steps: triagem.steps };
    const provider = mockProvider({ understand: [{ flows: {} }] });
    await understand(provider).run(request({ messageFlows: [triagem, outro] }));
    const { prompt } = provider.calls[0];

    expect(prompt).toContain("The customer: quer um orçamento");
    expect(prompt).toContain("Score 0 when: o cliente só está agradecendo");
    expect(prompt).not.toContain("The customer: quer um orçamento; o cliente só está agradecendo");
  });
});

describe("instructions", () => {
  test("an excluded condition reads as `never when`, beside any `apply only when`", () => {
    const section = instructionsSection(
      [
        {
          caption: "[Always]",
          items: [{ kind: "never", prompt: "Prometa desconto.", when: ["o lead pede desconto", "!o lead já tem proposta"] }],
        },
      ],
      { data: {}, context: undefined, input: undefined },
    );
    expect(section).toContain("(apply only when: o lead pede desconto; never when: o lead já tem proposta)");
  });

  test("exclusions alone still produce a usable clause", () => {
    const section = instructionsSection(
      [{ caption: "[Always]", items: [{ kind: "never", prompt: "Cite preço.", when: "!o lead já viu a tabela" }] }],
      { data: {}, context: undefined, input: undefined },
    );
    expect(section).toContain("(never when: o lead já viu a tabela)");
  });
});

describe("validateFlow", () => {
  test("a trigger made only of exclusions is rejected, because nothing could ever match it", () => {
    const dead: Flow<undefined, Data> = {
      ...humano,
      on: [{ mention: ["!o lead apenas concorda", "!menção casual a outras pessoas"] }],
    };
    expect(() => validateFlow(dead, registries)).toThrow(FlowConfigurationError);
    expect(() => validateFlow(dead, registries)).toThrow(/every mention phrase starts with "!"/);
  });

  test("an empty message list stays legal: it is the catch-all", () => {
    expect(() => validateFlow({ ...triagem, on: [{ message: [] }] }, registries)).not.toThrow();
  });

  test("one plain phrase beside any number of exclusions is fine", () => {
    expect(() => validateFlow(humano, registries)).not.toThrow();
  });
});
