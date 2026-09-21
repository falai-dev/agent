/**
 * Shared fixtures for the Speak tests: one agent, one flow, one asking run.
 */

import type { SpeakRequest } from "../src/core/contracts.js";
import type { AgentOptions } from "../src/types/agent.js";
import type { AiProvider } from "../src/types/ai.js";
import type { FieldDefs, Flow, StepBase, TalkStep } from "../src/types/flow.js";
import type { Run } from "../src/types/session.js";

export interface Ctx {
  empresa: string;
}

export interface Data {
  nome: string;
  tamanho: "1-10" | "11-50";
  orcamento: number;
}

export const fields: FieldDefs = {
  nome: { type: "string", ask: "Pergunte o nome de um jeito leve." },
  tamanho: { type: "string", enum: ["1-10", "11-50"], description: "Pessoas na empresa", ask: "Pergunte o porte." },
  orcamento: { type: "number", ask: "Pergunte a faixa de investimento." },
};

export const quem: StepBase<Data> & TalkStep<Ctx, Data> = {
  id: "quem",
  prompt: "Descubra quem é e de onde fala, em nome da {{context.empresa}}.",
  collect: ["nome", "tamanho"],
  ask: { tamanho: "Pergunte quantas pessoas trabalham lá; ofereça as faixas." },
};

export const triagem: Flow<Ctx, Data> = {
  id: "triagem",
  name: "Triagem",
  description: "Quem chega querendo saber se serve",
  steps: [quem],
};

export const run: Run = {
  id: "triagem#m1",
  flowId: "triagem",
  anchor: "s1",
  dedupeKey: "triagem:s1:",
  stepId: "quem",
  status: "asking",
  trigger: { kind: "message", key: "m1" },
  input: { origem: "site" },
  hop: 0,
  startedAt: "2026-09-20T10:00:00.000Z",
  asked: {},
  visits: { quem: 1 },
  outcomes: [],
};

export const context: Ctx = { empresa: "Acme" };
export const now = new Date("2026-09-20T10:00:00.000Z");

export function agentOptions(provider: AiProvider, extra: Partial<AgentOptions<Ctx, Data>> = {}): AgentOptions<Ctx, Data> {
  return {
    name: "Ana",
    persona: "Você fala pela {{context.empresa}}.",
    provider,
    fields,
    knowledgeBase: { horario: "9h às 18h" },
    ...extra,
  };
}

/** The `quem` step asking, with `orcamento` already known. */
export function talkRequest(
  overrides: Partial<SpeakRequest<Ctx, Data>> & { pending?: string[] } = {},
): SpeakRequest<Ctx, Data> {
  const { pending = ["nome", "tamanho"], ...rest } = overrides;
  return {
    talk: { run, flow: triagem, step: quem, pending },
    input: { kind: "message", text: "quero saber como funciona" },
    context,
    data: { orcamento: 1500 },
    history: [],
    now,
    instructions: [],
    tools: [],
    ...rest,
  };
}

export function idleRequest(overrides: Partial<SpeakRequest<Ctx, Data>> = {}): SpeakRequest<Ctx, Data> {
  return {
    talk: { idle: { prompt: "Responda pela empresa; não invente preços." } },
    input: { kind: "message", text: "obrigado" },
    context,
    data: {},
    history: [],
    now,
    instructions: [],
    tools: [],
    ...overrides,
  };
}
