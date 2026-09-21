/**
 * FlowSpec: the JSON form of a flow, its validation and the generation schema.
 *
 * The S7 rule from chat and the S1 triage flow are written as specs; both
 * must validate against the agent's registries and survive a round trip.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { falai } from "../src/core/falai.js";
import { flowSpecSchema, fromSpec, toSpec, validateFlow } from "../src/core/FlowSpec.js";
import type { FlowSpec, Registries, StepSpec, TriggerSpec } from "../src/core/FlowSpec.js";
import { FlowConfigurationError } from "../src/types/errors.js";
import type { ConditionSpec, Duration, Next } from "../src/types/flow.js";
import type { StructuredSchema } from "../src/types/schema.js";

// ── The registry: S1's fields, two actions, two events, one condition ───

interface LeadContext {
  lead: { id: string; tags: string[]; owner: "ai" | "human" };
}

const f = falai<LeadContext>().fields({
  nome: { type: "string", ask: "Pergunte o nome de um jeito leve, sem tom de formulário." },
  empresa: { type: "string", ask: "Pergunte de qual empresa a pessoa fala." },
  tamanho: { type: "string", enum: ["1-10", "11-50", "51-200", "200+"], ask: "Pergunte quantas pessoas trabalham lá." },
  urgencia: { type: "string", enum: ["agora", "30 dias", "sem prazo"], ask: "Pergunte para quando precisam resolver." },
  orcamento: { type: "number", ask: "Pergunte a faixa de investimento." },
  confirmado: { type: "boolean", ask: "Resuma o que anotou e pergunte se está tudo certo." },
  /** No `ask`: a collect step that lists only this field has nothing to go on. */
  cargo: { type: "string" },
});

const actions = {
  notify: f.action({
    parameters: { recipient: { type: "string" }, message: { type: "string" } },
    run: () => ({ ok: true }),
  }),
  add_tags: f.action({
    parameters: { tags: { type: "array", items: { type: "string" } } },
    run: () => ({ ok: true }),
  }),
};

const events = {
  stage_entered: f.event<{ stageId: string }>(),
  meeting_booked: f.event<{ eventId: string }>(),
};

const conditions = {
  tagsAny: f.condition((ctx, tags: string[]) => tags.some((t) => ctx.context.lead.tags.includes(t))),
};

const registries: Registries = { fields: f.fields, actions, events, conditions };

/** The data type a spec is written against: any slug, scalar values. */
type Loose = Record<string, string | number | boolean>;

// ── Fixtures ────────────────────────────────────────────────────────────

/** S7, verbatim from the design record. */
const concorrente: FlowSpec = {
  id: "concorrente",
  name: "Lead falou de concorrente",
  on: [
    {
      mention: ["o lead cita ou compara com um concorrente"],
      extract: { trecho: { type: "string" } },
      repeat: "once",
    },
  ],
  steps: [
    { id: "tag", kind: "do", do: "add_tags", with: { tags: ["concorrente"] } },
    {
      id: "avisa",
      kind: "do",
      do: "notify",
      with: { recipient: "owner", message: '{{data.nome}} falou de concorrente: "{{input.trecho}}"' },
    },
  ],
};

/** S1 as a spec: the flat step carries `kind`, everything else is the same. */
const triagemSpec: FlowSpec = {
  id: "triagem",
  name: "Triagem",
  description: "Quando alguém chega querendo saber se o produto serve para a empresa dele",
  on: [{ message: ["quer saber como funciona", "pede um orçamento", "quer saber se serve para a empresa"] }],
  steps: [
    { id: "quem", kind: "collect", prompt: "Descubra quem é e de onde fala.", collect: ["nome", "empresa"] },
    { id: "porte", kind: "collect", collect: ["tamanho", "urgencia"] },
    { id: "grana", kind: "collect", collect: ["orcamento"], maxAsks: 2 },
    { id: "confirma", kind: "collect", collect: ["confirmado"] },
    { id: "ok", kind: "if", if: { equals: { confirmado: true } }, else: { step: "quem", clear: ["confirmado"] } },
    {
      id: "avisa",
      kind: "do",
      do: "notify",
      with: {
        recipient: "leadAssignee",
        message: "Lead qualificado: {{data.nome}} ({{data.empresa}}), {{data.tamanho}} pessoas, {{data.urgencia}}.",
      },
    },
    { id: "tchau", kind: "prompt", prompt: "Agradeça e diga que um vendedor continua daqui." },
  ],
};

/** S1 typed, the way an app writes it. */
const triagem = f.flow({
  id: "triagem",
  name: "Triagem",
  description: "Quando alguém chega querendo saber se o produto serve para a empresa dele",
  on: [{ message: ["quer saber como funciona", "pede um orçamento", "quer saber se serve para a empresa"] }],
  steps: [
    { id: "quem", prompt: "Descubra quem é e de onde fala.", collect: ["nome", "empresa"] },
    { id: "porte", collect: ["tamanho", "urgencia"] },
    { id: "grana", collect: ["orcamento"], maxAsks: 2 },
    { id: "confirma", collect: ["confirmado"] },
    { id: "ok", if: { equals: { confirmado: true } }, else: { step: "quem", clear: ["confirmado"] } },
    {
      id: "avisa",
      do: "notify",
      with: {
        recipient: "leadAssignee",
        message: "Lead qualificado: {{data.nome}} ({{data.empresa}}), {{data.tamanho}} pessoas, {{data.urgencia}}.",
      },
    },
    { id: "tchau", prompt: "Agradeça e diga que um vendedor continua daqui." },
  ],
});

/** S2 typed: its trigger `if` is a function, so it validates but cannot be stored. */
const retomar = f.flow({
  id: "retomar",
  name: "Retomar quem sumiu",
  on: [{ silence: "24h", businessHours: true, if: ({ context }) => context.lead.owner === "ai" }],
  anchor: "lead",
  steps: [
    { id: "gate", if: { silenced: true }, then: "lembra", else: "p1" },
    { id: "p1", prompt: "Retome a conversa de forma leve." },
    { id: "w1", wait: "2d", else: "end" },
    { id: "p2", prompt: "Última tentativa, curta e sem pressão." },
    { id: "w2", wait: "3d", else: "end" },
    { id: "n1", do: "notify", with: { recipient: "leadAssignee", message: "{{data.nome}} não respondeu." }, then: "end" },
    { id: "lembra", do: "notify", with: { recipient: "leadAssignee", message: "Hora de fazer follow-up com {{data.nome}}." } },
  ],
});

/** A one-step spec with the given steps, for the error table. */
function spec(steps: StepSpec[], rest: Partial<Omit<FlowSpec, "steps">> = {}): FlowSpec {
  return { id: "fx", name: "Fixture", steps, ...rest };
}

/** The message `validateFlow` throws for this flow; fails the test when it does not throw. */
function problem(flow: FlowSpec, reg = registries): string {
  try {
    validateFlow(flow, reg);
  } catch (e) {
    if (e instanceof FlowConfigurationError) return e.message;
    throw e;
  }
  throw new Error("expected validateFlow to throw");
}

// ── fromSpec / toSpec ───────────────────────────────────────────────────

describe("fromSpec / toSpec", () => {
  test("S7 (concorrente) validates against the registry and round-trips", () => {
    const flow = fromSpec(concorrente);
    expect(validateFlow(flow, registries)).toEqual({ warnings: [] });
    expect(validateFlow(concorrente, registries)).toEqual({ warnings: [] });
    expect(toSpec(flow)).toEqual(concorrente);
  });

  test("S1 (triagem) as a spec is the typed flow, validates and round-trips", () => {
    expect<unknown>(fromSpec(triagemSpec)).toEqual(triagem);
    expect(validateFlow(triagemSpec, registries)).toEqual({ warnings: [] });
    expect(validateFlow(triagem, registries)).toEqual({ warnings: [] });
    expect(toSpec(fromSpec(triagemSpec))).toEqual(triagemSpec);
    expect(toSpec(triagem)).toEqual(triagemSpec);
  });

  test("kind rule: collect wins when a talk step has fields, prompt when it has a guideline alone", () => {
    const both = toSpec(f.flow({ id: "k", name: "K", steps: [{ id: "a", prompt: "Descubra.", collect: ["nome"] }] }));
    expect(both.steps[0]).toEqual({ id: "a", kind: "collect", prompt: "Descubra.", collect: ["nome"] });
    const alone = toSpec(f.flow({ id: "k", name: "K", steps: [{ id: "a", prompt: "Agradeça." }] }));
    expect(alone.steps[0]).toEqual({ id: "a", kind: "prompt", prompt: "Agradeça." });
  });

  test("nulls from the generation schema mean 'not set' and are dropped", () => {
    // A generated spec says null where the type says optional; the envelope style.
    const generated = JSON.parse(
      JSON.stringify({
        id: "g",
        name: "Gerado",
        description: null,
        on: null,
        anchor: null,
        while: null,
        clearOnStart: null,
        onEnd: null,
        instructions: null,
        steps: [
          { id: "a", kind: "say", say: "Oi!", label: null, then: null, media: null, once: null },
          { id: "b", kind: "wait", wait: "2d", businessHours: null, else: "end", branches: null, label: null, then: null },
          { id: "c", kind: "prompt", prompt: "Agradeça.", label: null, then: null, branches: null },
        ],
      }),
    ) as FlowSpec; // the wire form: nulls stand for absent optionals, which the type does not spell
    const flow = fromSpec(generated);
    expect(flow).toEqual({
      id: "g",
      name: "Gerado",
      steps: [
        { id: "a", say: "Oi!" },
        { id: "b", wait: "2d", else: "end" },
        { id: "c", prompt: "Agradeça." },
      ],
    });
    expect(validateFlow(generated, registries)).toEqual({ warnings: [] });
    expect(validateFlow({ ...generated, steps: [] }, registries)).toEqual({ warnings: [] });
  });

  test("toSpec refuses a function predicate and says where it is", () => {
    expect(validateFlow(retomar, registries)).toEqual({ warnings: [] });
    expect(() => toSpec(retomar)).toThrow(FlowConfigurationError);
    expect(() => toSpec(retomar)).toThrow('flow "retomar", trigger #1 if: is a function');

    const inStep = f.flow({
      id: "fn",
      name: "Fn",
      steps: [{ id: "gate", if: ({ context }) => context.lead.owner === "ai" }],
    });
    expect(() => toSpec(inStep)).toThrow('flow "fn", step "gate" if: is a function');
  });
});

// ── validateFlow ────────────────────────────────────────────────────────

describe("validateFlow throws, naming the flow, the step and the offender", () => {
  const say = (id: string, then?: Next<Loose>): StepSpec => (then === undefined ? { id, kind: "say", say: "Oi" } : { id, kind: "say", say: "Oi", then });

  test("a step with no id", () => {
    const stored = JSON.parse('{"id":"fx","name":"Fixture","steps":[{"kind":"say","say":"Oi"}]}') as FlowSpec; // stored JSON may lack it
    const m = problem(stored);
    expect(m).toStartWith("[FlowConfigurationError]");
    expect(m).toContain('flow "fx", step #1');
    expect(m).toContain("has no id");
    expect(problem(spec([{ id: "", kind: "say", say: "Oi" }]))).toContain("has no id");
  });

  test("a duplicate step id", () => {
    const m = problem(spec([say("a"), say("a")]));
    expect(m).toContain('flow "fx", step "a"');
    expect(m).toContain("duplicates");
  });

  test("the reserved id 'end'", () => {
    const m = problem(spec([say("end")]));
    expect(m).toContain('flow "fx", step "end"');
    expect(m).toContain('reserved id "end"');
  });

  test("then, else and branch targets that name no step", () => {
    expect(problem(spec([say("a", "nowhere")]))).toContain('step "a": then points at step "nowhere"');
    expect(problem(spec([{ id: "a", kind: "if", if: { silenced: true }, else: "nowhere" }]))).toContain(
      'step "a": else points at step "nowhere"',
    );
    expect(
      problem(spec([{ id: "a", kind: "prompt", prompt: "Pergunte.", branches: [{ when: "desistiu", then: "nowhere" }] }])),
    ).toContain('step "a": branches[0].then points at step "nowhere"');
    expect(problem(spec([{ id: "a", kind: "do", do: "notify", with: { recipient: "x", message: "y" }, onFail: "nowhere" }]))).toContain(
      'step "a": onFail points at step "nowhere"',
    );
  });

  test("field slugs not in the registry: collect, ask, clearOnStart, clear, equals, known", () => {
    expect(problem(spec([{ id: "a", kind: "collect", collect: ["telefone"] }]))).toContain(
      'step "a": unknown field "telefone" in collect',
    );
    expect(problem(spec([{ id: "a", kind: "collect", collect: ["nome"], ask: { telefone: "Peça." } }]))).toContain(
      'step "a": unknown field "telefone" in ask',
    );
    expect(problem(spec([say("a")], { clearOnStart: ["telefone"] }))).toContain('flow "fx": unknown field "telefone" in clearOnStart');
    expect(problem(spec([say("a", { step: "a", clear: ["telefone"] })]))).toContain('step "a": unknown field "telefone" in then.clear');
    expect(problem(spec([{ id: "a", kind: "if", if: { equals: { telefone: "x" } }, else: "end" }]))).toContain(
      'step "a": unknown field "telefone" in if.equals',
    );
    expect(problem(spec([{ id: "a", kind: "if", if: { known: ["telefone"] }, else: "end" }]))).toContain(
      'step "a": unknown field "telefone" in if.known',
    );
  });

  test("equals is not coerced: a string is not a boolean", () => {
    const m = problem(spec([{ id: "a", kind: "if", if: { equals: { confirmado: "sim" } }, else: "end" }]));
    expect(m).toContain('step "a": if.equals gives "confirmado" a string, but the field is a boolean');
  });

  test("do names not in actions", () => {
    const m = problem(spec([{ id: "a", kind: "do", do: "notifi", with: {} }]));
    expect(m).toContain('flow "fx", step "a": unknown action "notifi"');
  });

  test("with: a missing required parameter, a wrong scalar type, an unknown parameter", () => {
    expect(problem(spec([{ id: "a", kind: "do", do: "notify", with: { recipient: "owner" } }]))).toContain(
      'step "a": action "notify" needs parameter "message"',
    );
    expect(problem(spec([{ id: "a", kind: "do", do: "notify", with: { recipient: "owner", message: 42 } }]))).toContain(
      'step "a": parameter "message" of action "notify" must be a string, got number',
    );
    expect(problem(spec([{ id: "a", kind: "do", do: "add_tags", with: { tags: "concorrente" } }]))).toContain(
      'parameter "tags" of action "add_tags" must be a list of string, got string',
    );
    expect(problem(spec([{ id: "a", kind: "do", do: "add_tags", with: { tags: ["x"], urgent: true } }]))).toContain(
      'action "add_tags" has no parameter "urgent"',
    );
  });

  test("event names not in events: triggers and waitEvent", () => {
    expect(problem(spec([say("a")], { on: [{ event: "tag_added" }] }))).toContain('flow "fx", trigger #1: unknown event "tag_added"');
    expect(problem(spec([{ id: "a", kind: "waitEvent", wait: { event: "tag_added" } }]))).toContain(
      'flow "fx", step "a": unknown event "tag_added" in wait',
    );
  });

  test("condition names not in conditions and not built in, wherever a ConditionSpec sits", () => {
    const bad: ConditionSpec<Loose> = { inStage: "x" };
    expect(problem(spec([{ id: "a", kind: "if", if: bad, else: "end" }]))).toContain('step "a": unknown condition "inStage" in if');
    expect(problem(spec([say("a")], { while: bad }))).toContain('flow "fx": unknown condition "inStage" in while');
    expect(problem(spec([say("a")], { on: [{ message: [], if: bad }] }))).toContain('trigger #1: unknown condition "inStage" in if');
    expect(problem(spec([{ id: "a", kind: "prompt", prompt: "P.", branches: [{ if: bad, then: "end" }] }]))).toContain(
      'step "a": unknown condition "inStage" in branches[0].if',
    );
    expect(problem(spec([say("a")], { instructions: [{ prompt: "Seja breve.", if: bad }] }))).toContain(
      'flow "fx": unknown condition "inStage" in instructions[0].if',
    );
    // the built-ins and the registry's own pass
    expect(validateFlow(spec([{ id: "a", kind: "if", if: { silenced: true, known: ["nome"], tagsAny: ["vip"] }, else: "end" }]), registries)).toEqual({
      warnings: [],
    });
  });

  test("durations that do not parse: silence, after, cooldown, wait, upTo", () => {
    expect(problem(spec([say("a")], { on: [{ silence: "um dia" as Duration }] }))).toContain(
      'trigger #1: silence has duration "um dia", which does not parse',
    );
    expect(problem(spec([say("a")], { on: [{ event: "stage_entered", after: "3 days" as Duration }] }))).toContain(
      'trigger #1: after has duration "3 days"',
    );
    expect(problem(spec([say("a")], { on: [{ message: [], repeat: { cooldown: "1w" as Duration } }] }))).toContain(
      'trigger #1: repeat.cooldown has duration "1w"',
    );
    expect(problem(spec([{ id: "a", kind: "wait", wait: "2 dias" as Duration }]))).toContain('step "a": wait has duration "2 dias"');
    expect(problem(spec([{ id: "a", kind: "waitEvent", wait: { event: "meeting_booked", upTo: "30" as Duration } }]))).toContain(
      'step "a": wait.upTo has duration "30"',
    );
  });

  test("a backward if with no else", () => {
    const m = problem(spec([say("a"), { id: "b", kind: "if", if: { silenced: true }, then: "a" }]));
    expect(m).toContain('flow "fx", step "b": "if" jumps back to "a" with no else');
    // with an else it is a loop, allowed (and warned about, since nothing is cleared)
    const ok = validateFlow(spec([say("a"), { id: "b", kind: "if", if: { silenced: true }, then: "a", else: "end" }]), registries);
    expect(ok.warnings).toHaveLength(1);
  });

  test("triggers but no steps", () => {
    const m = problem(spec([], { on: [{ message: ["oi"] }] }));
    expect(m).toContain('flow "fx": has triggers but no steps');
    expect(validateFlow(spec([]), registries)).toEqual({ warnings: [] });
  });
});

describe("validateFlow warns", () => {
  test("a backward edge without clear", () => {
    const { warnings } = validateFlow(
      spec([{ id: "quem", kind: "collect", collect: ["nome"] }, { id: "volta", kind: "say", say: "De novo.", then: "quem" }]),
      registries,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('step "volta": then jumps back to "quem" without clear');
    expect(warnings[0]).toContain("clear: [...]");
  });

  test("a prompt-less collect step whose fields all lack ask", () => {
    const { warnings } = validateFlow(spec([{ id: "a", kind: "collect", collect: ["cargo"] }]), registries);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('step "a": collects "cargo" with no prompt and no ask');
    // a step ask, a field ask or a prompt each settle it
    expect(validateFlow(spec([{ id: "a", kind: "collect", collect: ["cargo"], ask: { cargo: "Pergunte o cargo." } }]), registries).warnings).toEqual([]);
    expect(validateFlow(spec([{ id: "a", kind: "collect", collect: ["cargo", "nome"] }]), registries).warnings).toEqual([]);
    expect(validateFlow(spec([{ id: "a", kind: "collect", collect: ["cargo"], prompt: "Descubra o cargo." }]), registries).warnings).toEqual([]);
  });
});

// ── flowSpecSchema ──────────────────────────────────────────────────────

/** The `anyOf` branches of a schema node, `[]` when it is not a union. */
function variants(schema: StructuredSchema): StructuredSchema[] {
  return Array.isArray(schema.anyOf) ? (schema.anyOf as StructuredSchema[]) : []; // StructuredSchema types anyOf as unknown
}

function prop(schema: StructuredSchema, name: string): StructuredSchema {
  const found = schema.properties?.[name];
  if (!found) throw new Error(`schema has no property "${name}"`);
  return found;
}

function stepVariants(schema: StructuredSchema): Record<string, StructuredSchema[]> {
  const byKind: Record<string, StructuredSchema[]> = {};
  for (const step of variants(prop(schema, "steps").items ?? {})) {
    const kind = String(prop(step, "kind").enum?.[0]);
    (byKind[kind] ??= []).push(step);
  }
  return byKind;
}

describe("flowSpecSchema", () => {
  const slugs = Object.keys(f.fields);

  test("is strict with no actions and no events", () => {
    const schema = flowSpecSchema({ fields: f.fields });
    expect(isStrictSchema(schema)).toBe(true);
    const kinds = Object.keys(stepVariants(schema)).sort();
    expect(kinds).toEqual(["collect", "if", "prompt", "say", "wait"]);
    expect(variants(prop(schema, "on").items ?? {})).toHaveLength(3);
  });

  test("is strict with three actions carrying array and optional parameters; names show up as enums", () => {
    const three = {
      ...actions,
      send_template: f.action({
        parameters: { templateId: { type: "string" }, urgent: { type: "boolean", optional: true } },
        run: () => ({ ok: true }),
      }),
    };
    const schema = flowSpecSchema({ fields: f.fields, actions: three, events, conditions });
    expect(isStrictSchema(schema)).toBe(true);

    const steps = stepVariants(schema);
    expect(Object.keys(steps).sort()).toEqual(["collect", "do", "if", "prompt", "say", "wait", "waitEvent"]);
    expect(steps.do.map((v) => prop(v, "do").enum?.[0]).sort()).toEqual(["add_tags", "notify", "send_template"]);

    const byName = Object.fromEntries(steps.do.map((v) => [String(prop(v, "do").enum?.[0]), prop(v, "with")]));
    expect(prop(byName.add_tags, "tags")).toEqual({ type: "array", items: { type: "string" } });
    expect(prop(byName.send_template, "templateId")).toEqual({ type: "string" });
    expect(prop(byName.send_template, "urgent")).toEqual({ type: ["boolean", "null"] });
    expect(byName.send_template.required).toEqual(["templateId", "urgent"]);
    expect("ask" in prop(prop(steps.if[0], "if"), "equals").properties!.nome).toBe(false);

    expect(prop(steps.collect[0], "collect").items?.enum).toEqual(slugs);
    expect(prop(schema, "clearOnStart").items?.enum).toEqual(slugs);
    expect(prop(prop(steps.waitEvent[0], "wait"), "event").enum).toEqual(["stage_entered", "meeting_booked"]);

    const triggers = variants(prop(schema, "on").items ?? {});
    const eventTrigger = triggers.find((t) => t.properties?.event);
    expect(prop(eventTrigger ?? {}, "event").enum).toEqual(["stage_entered", "meeting_booked"]);
    const condition = prop(steps.if[0], "if");
    expect(Object.keys(condition.properties ?? {})).toEqual(["equals", "known", "silenced", "tagsAny"]);

    // optional values accept null, the envelope style
    expect(prop(schema, "description").type).toEqual(["string", "null"]);
    expect(prop(steps.say[0], "then").anyOf).toContainEqual({ type: "null" });
  });
});

// ── Property: random JSON-only flows round-trip ─────────────────────────

describe("property", () => {
  const slugs = Object.keys(f.fields);
  const eventNames = Object.keys(events);
  const optional = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });

  const duration: fc.Arbitrary<Duration> = fc
    .tuple(fc.integer({ min: 1, max: 999 }), fc.constantFrom("s", "m", "h", "d"))
    .map(([n, unit]) => `${n}${unit}` as Duration); // the template-literal type cannot be inferred from a join
  const text = fc.constantFrom("Pergunte o nome.", "Oi {{data.nome}}!", "Agradeça.", "");
  const condition: fc.Arbitrary<ConditionSpec<Loose>> = fc.record(
    {
      equals: fc.record({ confirmado: fc.boolean(), tamanho: fc.constantFrom("1-10", "11-50") }, { requiredKeys: [] }),
      known: fc.subarray(slugs),
      silenced: fc.boolean(),
      tagsAny: fc.array(fc.string()),
    },
    { requiredKeys: [] },
  );
  const repeat = fc.oneof(fc.constantFrom("once" as const, "always" as const), fc.record({ cooldown: duration }));
  const trigger: fc.Arbitrary<TriggerSpec> = fc.oneof(
    fc.record({ message: fc.array(fc.string()), if: condition, repeat }, { requiredKeys: ["message"] }),
    fc.record(
      { mention: fc.array(fc.string()), extract: fc.constant({ trecho: { type: "string" } }), if: condition, repeat },
      { requiredKeys: ["mention"] },
    ),
    fc.record({ silence: duration, if: condition, businessHours: fc.boolean(), repeat }, { requiredKeys: ["silence"] }),
    fc.record(
      { event: fc.constantFrom(...eventNames), if: condition, after: duration, businessHours: fc.boolean(), repeat },
      { requiredKeys: ["event"] },
    ),
  );

  const next = (ids: string[]): fc.Arbitrary<Next<Loose>> =>
    fc.oneof(
      fc.constantFrom(...ids, "end"),
      fc.record({ step: fc.constantFrom(...ids), clear: fc.subarray(slugs) }, { requiredKeys: ["step"] }),
      fc.record({ flow: fc.constantFrom("agendar", "{{input.flowId}}") }),
    );
  const branches = (ids: string[]) =>
    fc.array(
      fc.oneof(fc.record({ when: fc.string(), then: next(ids) }), fc.record({ if: condition, then: next(ids) })),
      { maxLength: 2 },
    );

  const body = (ids: string[]): fc.Arbitrary<Omit<StepSpec, "id">> => {
    const base = { label: fc.string(), then: next(ids), ui: fc.constant({ x: 1 }) };
    return fc.oneof(
      fc.record({ kind: fc.constant("prompt" as const), prompt: text, branches: branches(ids), ...base }, { requiredKeys: ["kind", "prompt"] }),
      fc.record(
        { kind: fc.constant("collect" as const), collect: fc.subarray(slugs), prompt: text, maxAsks: fc.integer({ min: 1, max: 5 }), branches: branches(ids), ...base },
        { requiredKeys: ["kind", "collect"] },
      ),
      fc.record(
        { kind: fc.constant("say" as const), say: text, media: fc.record({ slug: fc.string() }), once: fc.boolean(), ...base },
        { requiredKeys: ["kind", "say"] },
      ),
      fc.record(
        {
          kind: fc.constant("do" as const),
          do: fc.constant("notify"),
          with: fc.record({ recipient: fc.string(), message: text }),
          onFail: next(ids),
          ...base,
        },
        { requiredKeys: ["kind", "do", "with"] },
      ),
      fc.record(
        { kind: fc.constant("wait" as const), wait: duration, businessHours: fc.boolean(), else: next(ids), branches: branches(ids), ...base },
        { requiredKeys: ["kind", "wait"] },
      ),
      fc.record(
        {
          kind: fc.constant("waitEvent" as const),
          wait: fc.record({ event: fc.constantFrom(...eventNames), upTo: duration }, { requiredKeys: ["event"] }),
          else: next(ids),
          ...base,
        },
        { requiredKeys: ["kind", "wait"] },
      ),
      fc.record({ kind: fc.constant("if" as const), if: condition, else: next(ids), ...base }, { requiredKeys: ["kind", "if"] }),
    );
  };

  const steps: fc.Arbitrary<StepSpec[]> = fc
    .uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/).filter((id) => id !== "end"), { minLength: 1, maxLength: 6 })
    .chain((ids) => fc.tuple(...ids.map((id) => body(ids).map((rest) => ({ id, ...rest }) as StepSpec)))); // `{ id } & Omit<StepSpec, 'id'>` does not redistribute over the union

  const flow: fc.Arbitrary<FlowSpec> = fc.record(
    {
      id: fc.stringMatching(/^[a-z][a-z0-9-]{0,11}$/),
      name: fc.string({ minLength: 1 }),
      description: fc.string(),
      on: fc.array(trigger, { maxLength: 3 }),
      anchor: fc.constantFrom("session", "lead"),
      while: condition,
      clearOnStart: fc.subarray(slugs),
      steps,
      onEnd: fc.constantFrom("end" as const, "stay" as const, "reset" as const),
      instructions: fc.array(fc.record({ prompt: text, kind: fc.constantFrom("must" as const, "never" as const, "should" as const), if: condition }, { requiredKeys: ["prompt"] }), { maxLength: 2 }),
      tools: fc.array(fc.string(), { maxLength: 2 }),
    },
    { requiredKeys: ["id", "name", "steps"] },
  );

  test("toSpec(fromSpec(spec)) is the spec; validateFlow either passes or throws the typed error", () => {
    fc.assert(
      fc.property(flow, (generated) => {
        expect(toSpec(fromSpec(generated))).toEqual(generated);
        try {
          validateFlow(generated, registries);
        } catch (e) {
          expect(e).toBeInstanceOf(FlowConfigurationError);
        }
      }),
      { numRuns: 300 },
    );
  });

  test("the generation schema stays strict for any field set", () => {
    const fieldArb = fc.record({
      type: fc.constantFrom("string", "number", "integer", "boolean") as fc.Arbitrary<"string" | "number" | "integer" | "boolean">,
      ask: optional(fc.string()),
    });
    fc.assert(
      fc.property(fc.dictionary(fc.stringMatching(/^[a-z_]{1,12}$/), fieldArb), (fields) => {
        expect(isStrictSchema(flowSpecSchema({ fields, actions, events, conditions }))).toBe(true);
      }),
    );
  });
});

/**
 * Every object is closed and requires all of its properties. The helper from
 * tests/schema.test.ts, extended to walk `anyOf` branches and `items` so the
 * step union and every list inside it are checked too.
 */
function isStrictSchema(schema: StructuredSchema): boolean {
  if (!variants(schema).every(isStrictSchema)) return false;
  if (schema.items && !isStrictSchema(schema.items)) return false;
  if (schema.type !== "object" && !(Array.isArray(schema.type) && schema.type.includes("object"))) return true;
  const keys = Object.keys(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  return (
    schema.additionalProperties === false &&
    keys.every((k) => required.has(k)) &&
    Object.values(schema.properties ?? {}).every(isStrictSchema)
  );
}
