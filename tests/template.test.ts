import { describe, expect, test } from "bun:test";

import { render, renderDeep } from "../src/utils/template.js";

describe("render", () => {
  const scope = {
    data: { nome: "Ana", tamanho: "11-50", tags: ["vip", "novo"], confirmado: false, vazio: null },
    context: { lead: { name: "Ana Souza", stage: { id: "s1" } } },
    input: { trecho: "vi o concorrente X" },
  };

  test("fills data, context and input paths", () => {
    expect(render("{{data.nome}} ({{data.tamanho}}) — {{context.lead.stage.id}}: \"{{input.trecho}}\"", scope)).toBe(
      'Ana (11-50) — s1: "vi o concorrente X"',
    );
  });

  test("keeps the placeholder when the path resolves to nothing", () => {
    expect(render("Oi {{data.typo}} e {{data.vazio}}", scope)).toBe("Oi {{data.typo}} e {{data.vazio}}");
  });

  test("joins arrays, prints booleans, tolerates spaces", () => {
    expect(render("{{ data.tags }} / {{data.confirmado}}", scope)).toBe("vip, novo / false");
  });

  test("renderDeep walks objects and arrays and leaves other values alone", () => {
    expect(
      renderDeep({ recipient: "owner", message: "Lead {{data.nome}}", tags: ["{{data.tamanho}}"], n: 3 }, scope),
    ).toEqual({ recipient: "owner", message: "Lead Ana", tags: ["11-50"], n: 3 });
  });
});
