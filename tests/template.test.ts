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

  test("an empty value takes the gap with it", () => {
    const blank = { context: { lead: { name: "", company: "" } } };
    expect(render("Ola {{context.lead.name}}, tudo bem?", blank)).toBe("Ola, tudo bem?");
    expect(render("Vi que a {{context.lead.company}} esta contratando.", blank)).toBe(
      "Vi que a esta contratando.",
    );
    expect(render("Ate mais {{context.lead.name}}", blank)).toBe("Ate mais");
  });

  test("tidy only runs where something substituted to empty", () => {
    // Two spaces the author typed stay put when no value came back blank.
    expect(render("Oi  {{data.nome}} , beleza ?", scope)).toBe("Oi  Ana , beleza ?");
  });

  test("a null container is absent, a null field is unknown", () => {
    const noLead = { context: { lead: null }, data: { vazio: null } };

    // There is no lead, so "the lead's name" is blank — not mistyped.
    expect(render("Ola {{context.lead.name}}, tudo bem?", noLead)).toBe("Ola, tudo bem?");
    // The field exists and collected nothing. That one stays visible.
    expect(render("Oi {{data.vazio}}", noLead)).toBe("Oi {{data.vazio}}");
    // And a container that is simply missing is still a typo.
    expect(render("Oi {{context.leed.name}}", noLead)).toBe("Oi {{context.leed.name}}");
  });

  test("tidy leaves indentation alone", () => {
    const blank = { data: { nota: "" } };
    expect(render("Itens:\n  - um\n  - dois {{data.nota}}", blank)).toBe("Itens:\n  - um\n  - dois");
  });

  test("renderDeep walks objects and arrays and leaves other values alone", () => {
    expect(
      renderDeep({ recipient: "owner", message: "Lead {{data.nome}}", tags: ["{{data.tamanho}}"], n: 3 }, scope),
    ).toEqual({ recipient: "owner", message: "Lead Ana", tags: ["11-50"], n: 3 });
  });
});
