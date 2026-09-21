import { describe, expect, test } from "bun:test";

import {
  describeField,
  factsSection,
  identitySection,
  instructionsSection,
  joinSections,
  knowledgeSection,
  pendingSection,
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
