import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { FlowConfigurationError } from "../src/types/errors.js";
import type { FieldDefs } from "../src/types/flow.js";
import {
  buildSchema,
  coerceField,
  extractMode,
  isKnown,
  pendingFields,
  toWireSchema,
} from "../src/utils/schema.js";
import { isStrictSchema } from "./helpers.js";

const fields: FieldDefs = {
  nome: { type: "string", label: "Nome", ask: "Pergunte o nome." },
  tamanho: { type: "string", enum: ["1-10", "11-50"], ask: "Pergunte o porte." },
  orcamento: { type: "number", ask: "Pergunte a faixa.", description: "Faixa em reais" },
  confirmado: { type: "boolean", ask: "Confirme." },
};

describe("isKnown / pendingFields", () => {
  test("undefined, null and '' are unknown; 0 and false are known", () => {
    expect([undefined, null, ""].map(isKnown)).toEqual([false, false, false]);
    expect([0, false, "x"].map(isKnown)).toEqual([true, true, true]);
  });

  test("pending keeps order, drops known fields and fields at maxAsks", () => {
    const step = { collect: ["nome", "tamanho", "orcamento"], maxAsks: 2 };
    expect(pendingFields(step, { tamanho: "1-10" }, { orcamento: 2 })).toEqual(["nome"]);
    expect(pendingFields({ collect: ["nome"] }, {}, { nome: 3 })).toEqual([]);
    expect(pendingFields({ collect: ["nome"] }, {}, { nome: 2 })).toEqual(["nome"]);
  });

  test("booleans default to 'asked', the rest to 'anywhere'", () => {
    expect(extractMode(fields.confirmado)).toBe("asked");
    expect(extractMode(fields.nome)).toBe("anywhere");
    expect(extractMode({ type: "boolean", extract: "anywhere" })).toBe("anywhere");
  });
});

describe("coerceField", () => {
  test("coerces strings to numbers and booleans, enforces enums", () => {
    expect(coerceField(fields.orcamento, "1.500,50")).toEqual({ ok: false, code: "bad-value" });
    expect(coerceField(fields.orcamento, "1500,50")).toEqual({ ok: true, value: 1500.5 });
    expect(coerceField({ type: "integer" }, "7.9")).toEqual({ ok: true, value: 7 });
    expect(coerceField(fields.confirmado, "sim")).toEqual({ ok: true, value: true });
    expect(coerceField(fields.confirmado, "não")).toEqual({ ok: true, value: false });
    expect(coerceField(fields.confirmado, "talvez").ok).toBe(false);
    expect(coerceField(fields.tamanho, "11-50")).toEqual({ ok: true, value: "11-50" });
    expect(coerceField(fields.tamanho, "200+")).toEqual({ ok: false, code: "not-in-enum" });
    expect(coerceField(fields.nome, 42)).toEqual({ ok: true, value: "42" });
    expect(coerceField(fields.nome, { a: 1 }).ok).toBe(false);
  });
});

describe("toWireSchema", () => {
  test("strips label/ask/extract and closes the object", () => {
    expect(toWireSchema(fields)).toEqual({
      type: "object",
      properties: {
        nome: { type: "string" },
        tamanho: { type: "string", enum: ["1-10", "11-50"] },
        orcamento: { type: "number", description: "Faixa em reais" },
        confirmado: { type: "boolean" },
      },
      required: ["nome", "tamanho", "orcamento", "confirmado"],
      additionalProperties: false,
    });
  });

  test("nullable envelopes make every property required and null-accepting", () => {
    const wire = toWireSchema({ nome: fields.nome }, { nullable: true });
    expect(wire.properties?.nome).toEqual({ type: ["string", "null"] });
    expect(wire.required).toEqual(["nome"]);
  });

  test("optional parameters leave the required list; arrays carry items", () => {
    const wire = toWireSchema({
      tags: { type: "array", items: { type: "string" } },
      urgent: { type: "boolean", optional: true },
    });
    expect(wire.properties?.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(wire.required).toEqual(["tags"]);
  });

  test("property: the wire schema is strict for any field set", () => {
    const fieldArb = fc.record({
      type: fc.constantFrom("string", "number", "integer", "boolean") as fc.Arbitrary<"string" | "number" | "integer" | "boolean">,
      ask: fc.string(),
      description: fc.option(fc.string(), { nil: undefined }),
      extract: fc.option(fc.constantFrom("anywhere", "asked") as fc.Arbitrary<"anywhere" | "asked">, { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.dictionary(fc.stringMatching(/^[a-z_]{1,12}$/), fieldArb), fc.boolean(), (defs, nullable) => {
        const wire = toWireSchema(defs, { nullable });
        expect(isStrictSchema(wire)).toBe(true);
        for (const prop of Object.values(wire.properties ?? {})) {
          expect("ask" in prop).toBe(false);
          expect("extract" in prop).toBe(false);
        }
      }),
    );
  });
});

describe("buildSchema", () => {
  test("merges rows by slug; first label and ask win; type conflicts throw", () => {
    const merged = buildSchema([
      { id: "triagem", fields: { nome: { type: "string", ask: "A" } } },
      { id: "agenda", fields: { nome: { type: "string", label: "Nome", ask: "B", description: "d" }, dia: { type: "string" } } },
    ]);
    expect(merged.nome).toEqual({ type: "string", label: "Nome", ask: "A", description: "d", enum: undefined, extract: undefined });
    expect(Object.keys(merged)).toEqual(["nome", "dia"]);

    expect(() =>
      buildSchema([
        { id: "triagem", fields: { tamanho: { type: "string" } } },
        { id: "agenda", fields: { tamanho: { type: "number" } } },
      ]),
    ).toThrow(FlowConfigurationError);
  });
});

/** Every object is closed and requires all of its properties. */
