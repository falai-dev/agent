/**
 * S14 — the data belongs to the flow. `flow.collect` lists what a flow needs,
 * its talk steps choose what to ask and when, and a step may open with a fixed
 * question that costs no model call.
 */
import { describe, expect, test } from "bun:test";

import type { GenerateMessageInput, StructuredSchema } from "../../src/index.js";
import { ai, build, f, message, saved, spoken, understood } from "./fixture.js";

/** The fields an understand call offered the model. */
const offered = (input: GenerateMessageInput): string[] => {
  const schema = input.parameters?.jsonSchema as StructuredSchema; // the mock records the input as the provider got it
  return Object.keys(schema.properties?.fields?.properties ?? {});
};

const start = (flow: string, extra: Record<string, unknown> = {}) => ({ sessionId: "s1", context: ai, start: { flow, key: "k" }, ...extra });

describe("S14: a flow lists its data; steps ask for it", () => {
  const agenda = f.flow({
    id: "agenda",
    name: "Agendamento",
    on: [{ message: ["quer agendar uma visita"] }],
    collect: ["nome", "orcamento"],
    steps: [
      { id: "quem", prompt: "Pergunte o nome para marcar a visita.", collect: ["nome"] },
      { id: "fim", prompt: "Diga que a visita está marcada." },
    ],
  });

  test("a field only the flow lists is noted from any message while the flow holds the conversation", async () => {
    const { agent, provider } = build([agenda], {
      script: {
        understand: [understood({ flows: { agenda: 90 } }), understood({ fields: { nome: "Ana", orcamento: 5000 } })],
        speak: [spoken("Claro! Qual é o seu nome?"), spoken("Pronto, Ana: visita marcada.")],
      },
    });
    const t1 = await agent.turn(message("quero agendar uma visita", "m1"));
    expect(offered(provider.calls[0].input)).toEqual(["nome", "orcamento"]);
    const t2 = await agent.turn(message("Ana, e tenho uns 5 mil", "m2", { session: saved(t1) }));
    expect(offered(provider.calls[2].input)).toEqual(["nome", "orcamento"]);
    expect(t2.session.data).toEqual({ nome: "Ana", orcamento: 5000 });
    expect(t2.messages.map((m) => m.stepId)).toEqual(["fim"]);
  });

  const rota = (first: Record<string, unknown> = {}) =>
    f.flow({
      id: "rota",
      name: "Rota inicial",
      on: [{ message: [] }],
      collect: ["nome", "modelo"],
      steps: [
        { id: "quem", collect: ["nome"], ...first },
        { id: "fim", prompt: "Diga que vai separar o aparelho." },
      ],
    });

  test("the rota inicial reads its whole list from the opening message", async () => {
    const { agent, provider } = build([rota()], {
      script: { understand: [understood({ fields: { nome: "Ana", modelo: "17 Pro" } })], speak: [spoken("Separando o 17 Pro para você, Ana.")] },
    });
    const r = await agent.turn(message("oi, sou a Ana e quero um 17 pro", "m1"));
    expect(provider.calls.map((c) => c.schemaName)).toEqual(["understand", "speak"]);
    expect(offered(provider.calls[0].input)).toEqual(["nome", "modelo"]);
    expect(r.session.data).toEqual({ nome: "Ana", modelo: "17 Pro" });
    expect(r.outcomes[0]).toMatchObject({ stepId: "quem", status: "skipped", code: "already-known" });
  });

  test("with only its first step's fields left, the opening turn spends one call: the ask reads them", async () => {
    const { agent, provider } = build([rota()], { script: { speak: [spoken("Oi! Como você se chama?")] } });
    const r = await agent.turn(message("oi", "m1", { session: { id: "s1", v: 4, version: 1, data: { modelo: "17" }, runs: [], claims: {}, inputs: [], metadata: {} } }));
    expect(provider.calls.map((c) => c.schemaName)).toEqual(["speak"]);
    expect(r.llmCalls).toBe(1);
  });

  test("a first step with a fixed question has no speak call to read its fields, so the opening turn is judged", async () => {
    const { agent, provider } = build([rota({ question: "Oi! Como você se chama?" })], {
      script: { understand: [understood({ fields: { nome: "Ana" } })], speak: [spoken("Separando para você, Ana.")] },
    });
    const r = await agent.turn(message("oi, aqui é a Ana", "m1", { session: { id: "s1", v: 4, version: 1, data: { modelo: "17" }, runs: [], claims: {}, inputs: [], metadata: {} } }));
    expect(provider.calls.map((c) => c.schemaName)).toEqual(["understand", "speak"]);
    expect(r.messages.map((m) => m.text)).toEqual(["Separando para você, Ana."]);
  });
});

describe("S14: a fixed question", () => {
  const cadastro = (step: Record<string, unknown> = {}) =>
    f.flow({
      id: "cadastro",
      name: "Cadastro",
      steps: [
        { id: "q", collect: ["nome", "empresa"], question: "Oi! Qual é o seu nome, e de qual empresa você fala?", maxAsks: 2, ...step },
        { id: "fim", prompt: "Agradeça." },
      ],
    });

  test("the first ask is the text word for word, with no model call", async () => {
    const { agent, provider } = build([cadastro()]);
    const r = await agent.turn(start("cadastro"));
    expect(provider.calls).toEqual([]);
    expect(r.llmCalls).toBe(0);
    expect(r.messages).toEqual([
      { text: "Oi! Qual é o seu nome, e de qual empresa você fala?", kind: "verbatim", afterMs: 0, key: "cadastro#k:q:1", runId: "cadastro#k", stepId: "q" },
    ]);
    expect(r.outcomes).toEqual([expect.objectContaining({ kind: "collect", status: "ok", code: "asked-fixed", stepId: "q" })]);
    expect(r.session.runs[0]).toMatchObject({ stepId: "q", status: "asking", asked: { nome: 1, empresa: 1 } });
    expect(r.session.lastAssistantAt).toBeDefined();
  });

  test("with part of the data already known, the AI asks for the rest", async () => {
    const { agent, provider } = build([cadastro()], { script: { speak: [spoken("E de qual empresa você fala, Ana?")] } });
    const r = await agent.turn(start("cadastro", { session: { id: "s1", v: 4, version: 1, data: { nome: "Ana" }, runs: [], claims: {}, inputs: [], metadata: {} } }));
    expect(provider.calls.map((c) => c.schemaName)).toEqual(["speak"]);
    expect(r.messages.map((m) => m.kind)).toEqual(["ai"]);
  });

  test("a later ask is the AI's own words, then max-asks moves on", async () => {
    const { agent, provider } = build([cadastro()], {
      script: { understand: [understood(), understood()], speak: [spoken("Pode me dizer seu nome e a empresa?"), spoken("Obrigada!")] },
    });
    const t1 = await agent.turn(start("cadastro"));
    const t2 = await agent.turn(message("hm", "m2", { session: saved(t1) }));
    expect(t2.messages.map((m) => [m.kind, m.text])).toEqual([["ai", "Pode me dizer seu nome e a empresa?"]]);
    expect(t2.session.runs[0].asked).toEqual({ nome: 2, empresa: 2 });
    const t3 = await agent.turn(message("hm", "m3", { session: saved(t2) }));
    expect(t3.outcomes.map((o) => o.code)).toContain("max-asks");
    expect(t3.messages.map((m) => m.stepId)).toEqual(["fim"]);
    expect(provider.remaining()).toEqual({ understand: 0, speak: 0 });
  });

  test("reached after the turn's speak call, it goes out in the same turn", async () => {
    const boasVindas = f.flow({
      id: "bv",
      name: "Boas-vindas",
      on: [{ message: ["quer comprar"] }],
      steps: [
        { id: "oi", prompt: "Cumprimente." },
        { id: "q", collect: ["nome"], question: "Qual é o seu nome?" },
      ],
    });
    const { agent } = build([boasVindas], { script: { understand: [understood({ flows: { bv: 90 } })], speak: [spoken("Oi! Que bom te ver.")] } });
    const r = await agent.turn(message("quero comprar", "m1"));
    expect(r.llmCalls).toBe(2);
    expect(r.messages.map((m) => [m.kind, m.text, m.stepId])).toEqual([
      ["ai", "Oi! Que bom te ver.", "oi"],
      ["verbatim", "Qual é o seu nome?", "q"],
    ]);
    expect(r.session.runs[0]).toMatchObject({ stepId: "q", status: "asking", asked: { nome: 1 } });
  });

  test("a confirm loop that clears the answer asks from scratch: the fixed question again, one ask counted", async () => {
    const confirma = f.flow({
      id: "confirma",
      name: "Confirma",
      steps: [
        { id: "c", collect: ["confirmado"], question: "Posso confirmar o pedido?" },
        { id: "ok", if: { equals: { confirmado: true } }, else: { step: "c", clear: ["confirmado"] } },
        { id: "fim", prompt: "Agradeça." },
      ],
    });
    const { agent } = build([confirma], { script: { speak: [spoken("Tudo bem, vamos rever.", { confirmado: false })] } });
    const t1 = await agent.turn(start("confirma"));
    const t2 = await agent.turn(message("não", "m2", { session: saved(t1) }));
    expect(t2.messages.map((m) => [m.kind, m.text])).toEqual([
      ["ai", "Tudo bem, vamos rever."],
      ["verbatim", "Posso confirmar o pedido?"],
    ]);
    expect(t2.session.runs[0]).toMatchObject({ stepId: "c", status: "asking", asked: { confirmado: 1 }, visits: { c: 2, ok: 1 } });
  });

  test("a run staying on the step answers in the AI's words", async () => {
    const faq = f.flow({ id: "faq", name: "FAQ", onEnd: "stay", steps: [{ id: "q", collect: ["nome"], question: "Qual é o seu nome?" }] });
    const { agent, provider } = build([faq], { script: { understand: [understood()], speak: [spoken("Posso ajudar em mais alguma coisa?")] } });
    const known = { id: "s1", v: 4 as const, version: 1, data: { nome: "Ana" }, runs: [], claims: {}, inputs: [], metadata: {} };
    const t1 = await agent.turn(start("faq", { session: known }));
    expect(t1.session.runs[0]).toMatchObject({ stepId: "q", staying: true });
    // The name is forgotten elsewhere (another flow's clearOnStart); the staying run still answers, it does not re-ask.
    const t2 = await agent.turn(message("e o horário?", "m2", { session: { ...saved(t1), data: {} } }));
    expect(provider.calls.map((c) => c.schemaName)).toEqual(["understand", "speak"]);
    expect(t2.messages.map((m) => m.kind)).toEqual(["ai"]);
  });
});
