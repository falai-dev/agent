import { describe, expect, test } from "bun:test";

import {
  describeField,
  factsSection,
  identitySection,
  instructionsSection,
  joinSections,
  knowledgeSection,
  pendingSection,
  stablePrefix,
} from "../src/core/Prompt.js";
import type { FieldDefs } from "../src/types/flow.js";

const scope = { data: { nome: "Ana" }, context: { empresa: "Acme" } };

const fields: FieldDefs = {
  nome: { type: "string", ask: "Pergunte o nome de um jeito leve." },
  tamanho: { type: "string", enum: ["1-10", "11-50"], description: "Pessoas na empresa", ask: "Pergunte o porte." },
  orcamento: { type: "number" },
};

describe("Prompt sections", () => {
  test("identity renders persona and goal templates", () => {
    expect(identitySection({ name: "Ana", persona: "Você fala pela {{context.empresa}}.", goal: "Qualificar" }, scope)).toBe(
      '## Identity\nYou are "Ana". Always refer to yourself by this name.\nVocê fala pela Acme.\nYour goal: Qualificar',
    );
  });

  test("knowledge nests objects and joins scalar arrays; empty is null", () => {
    expect(knowledgeSection(undefined)).toBeNull();
    expect(knowledgeSection({})).toBeNull();
    expect(
      knowledgeSection({ horario: "9h-18h", planos: { basico: 99, pro: 199 }, cidades: ["SP", "RJ"], equipe: [{ nome: "Bia" }] }),
    ).toBe(
      ["## Knowledge base", "- horario: 9h-18h", "- planos:", "  - basico: 99", "  - pro: 199", "- cidades: SP, RJ", "- equipe:", "  - nome: Bia"].join("\n"),
    );
  });

  test("instructions carry kind, caption and when; empty prompts are dropped", () => {
    const section = instructionsSection(
      [
        { caption: "[Always]", items: [{ kind: "never", prompt: "Não invente preços." }, { prompt: "   " }] },
        { caption: "[In: Triagem]", items: [{ prompt: "Seja breve com {{data.nome}}.", when: ["o lead está com pressa", "é fim de expediente"] }] },
      ],
      scope,
    );
    expect(section).toBe(
      [
        "## Instructions",
        "- [never] [Always] Não invente preços.",
        "- [should] [In: Triagem] Seja breve com Ana. (apply only when: o lead está com pressa OR é fim de expediente)",
      ].join("\n"),
    );
    expect(instructionsSection([{ caption: "[Always]", items: [] }], scope)).toBeNull();
  });

  test("facts list only known fields", () => {
    expect(factsSection(fields, {})).toBeNull();
    expect(factsSection(fields, { nome: "Ana", tamanho: "", orcamento: 0 })).toBe(
      ["## Already known", "These are settled. Never ask for them again; acknowledge and move on.", '- nome: "Ana"', "- orcamento: 0"].join("\n"),
    );
  });

  test("pending fields show type, options, description and how to ask; step wording wins", () => {
    expect(describeField("tamanho", fields.tamanho)).toBe("tamanho (string) [1-10 | 11-50]: Pessoas na empresa");
    const section = pendingSection(["tamanho", "orcamento"], fields, { orcamento: "Pergunte a faixa para {{data.nome}}." }, scope);
    expect(section).toContain("- tamanho (string) [1-10 | 11-50]: Pessoas na empresa\n  How to ask: Pergunte o porte.");
    expect(section).toContain("- orcamento (number)\n  How to ask: Pergunte a faixa para Ana.");
    expect(pendingSection([], fields, {}, scope)).toBeNull();
  });

  test("joinSections drops empty parts", () => {
    expect(joinSections("a", null, "  ", undefined, "b")).toBe("a\n\nb");
  });
});

describe("stablePrefix: what can be cached", () => {
  const knowledgeBase = { horario: "9h às 18h" };

  test("plain identity and the knowledge base become the system message", () => {
    const { system, inline } = stablePrefix({ name: "Ana", persona: "Você fala pela Acme.", knowledgeBase }, {});
    expect(inline).toBeNull();
    expect(system).toContain('You are "Ana"');
    expect(system).toContain("Você fala pela Acme.");
    expect(system).toContain("- horario: 9h às 18h");
  });

  test("a persona that interpolates a field stays inline", () => {
    // Cached, it would pay the write every turn and never read: the text
    // changes the moment `nome` lands.
    const { system, inline } = stablePrefix(
      { name: "Ana", persona: "Você atende {{data.nome}}.", knowledgeBase },
      { data: { nome: "Bia" } },
    );
    expect(inline).toContain("Você atende Bia.");
    expect(system).toBe("## Knowledge base\n- horario: 9h às 18h");
    expect(system).not.toContain("Bia");
  });

  test("a templated goal moves identity inline too", () => {
    const { system, inline } = stablePrefix({ name: "Ana", goal: "Qualificar {{context.tipo}}." }, { context: { tipo: "leads" } });
    expect(inline).toContain("Qualificar leads.");
    expect(system).toBeNull();
  });

  test("with nothing stable to say there is no system message at all", () => {
    expect(stablePrefix({ name: "Ana" }, {}).system).toContain('You are "Ana"');
    expect(stablePrefix({ name: "Ana", persona: "{{data.x}}" }, {}).system).toBeNull();
  });
});
