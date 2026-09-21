/**
 * One toolkit for the S1–S13 scenarios of docs/rfc/v4-one-flow.md, all
 * driven through `agent.turn()` with the mock provider, a fake clock and
 * stubbed actions. Every scenario asserts `llmCalls`, the deterministic keys
 * and the pt-BR outcome lines.
 */

import type { Agent } from "../../src/core/Agent.js";
import { falai, fakeClock } from "../../src/index.js";
import type {
  ActionResult,
  AgentOptions,
  DataOf,
  FakeClock,
  Flow,
  Session,
  Tool,
  TurnInput,
  TurnResult,
} from "../../src/index.js";
import { mockProvider, type MockProvider, type Scripted } from "../mock-provider.js";

export interface Ctx {
  lead: { id: string; tags: string[]; owner: "ai" | "human"; stageId?: string };
}

export const f = falai<Ctx>().fields({
  nome: { type: "string", ask: "Pergunte o nome de um jeito leve, sem tom de formulário." },
  empresa: { type: "string", ask: "Pergunte de qual empresa a pessoa fala." },
  tamanho: { type: "string", enum: ["1-10", "11-50", "51-200", "200+"], ask: "Pergunte quantas pessoas trabalham lá; ofereça as faixas." },
  urgencia: { type: "string", enum: ["agora", "30 dias", "sem prazo"], ask: "Pergunte para quando precisam resolver." },
  orcamento: { type: "number", ask: "Pergunte a faixa de investimento, dizendo que é só para orientar." },
  confirmado: { type: "boolean", ask: "Resuma em uma frase o que anotou e pergunte se está tudo certo." },
  modelo: { type: "string", ask: "Pergunte qual modelo interessa." },
});

export type Data = DataOf<typeof f>;

export const T0 = "2026-09-20T10:00:00.000Z";
export const ai: Ctx = { lead: { id: "l1", tags: ["vip"], owner: "ai" } };
export const human: Ctx = { lead: { id: "l1", tags: ["vip"], owner: "human" } };

export interface ActionCall {
  action: string;
  key: string;
  dedupeKey: string;
  params: Record<string, unknown>;
}

export const events = {
  stage_entered: f.event<{ stageId: string }>(),
  meeting_booked: f.event<{ eventId: string }>(),
  ig_comment: f.event<{ text: string }>(),
  reaction: f.event<{ emoji: string }>({ direction: "inbound" }),
  human_message: f.event<{ text: string }>({ direction: "outbound" }),
};

export const conditions = {
  tagsAny: f.condition((ctx, tags: string[]) => tags.some((t) => ctx.context.lead.tags.includes(t))),
  inStage: f.condition((ctx, stageId: string) => ctx.context.lead.stageId === stageId),
};

export interface Harness {
  agent: Agent<Ctx, Data>;
  provider: MockProvider;
  clock: FakeClock;
  /** Every host action call, in order. */
  calls: ActionCall[];
}

export interface BuildOptions {
  /** Scripted provider replies per schema name; see `understood` and `spoken`. */
  script?: Record<string, Scripted[]>;
  /** What an action returns; default `{ ok: true }`. `n` counts calls so far. */
  reply?: (name: string, n: number, params: Record<string, unknown>) => ActionResult;
  tools?: Tool<Ctx, Data>[];
  idle?: AgentOptions<Ctx, Data>["idle"];
  instructions?: AgentOptions<Ctx, Data>["instructions"];
  businessHours?: AgentOptions<Ctx, Data>["businessHours"];
}

export function build(flows: Flow<Ctx, Data>[], options: BuildOptions = {}): Harness {
  const clock = fakeClock(T0);
  const calls: ActionCall[] = [];
  const action = <const P extends Parameters<typeof f.action>[0]["parameters"]>(name: string, parameters: P) =>
    f.action({
      parameters,
      run: (params, ctx) => {
        calls.push({ action: name, key: ctx.key, dedupeKey: ctx.dedupeKey, params });
        return options.reply ? options.reply(name, calls.length, params) : { ok: true };
      },
    });
  const provider = mockProvider(options.script);
  const agent = f.agent({
    name: "Ana",
    persona: "Vendedora simpática e direta.",
    provider,
    flows,
    events,
    conditions,
    actions: {
      notify: action("notify", { recipient: { type: "string" }, message: { type: "string" } }),
      add_tags: action("add_tags", { tags: { type: "array", items: { type: "string" } } }),
      assign_lead: action("assign_lead", { to: { type: "string", optional: true } }),
      send_template: action("send_template", { templateId: { type: "string" } }),
    },
    clock,
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.idle ? { idle: options.idle } : {}),
    ...(options.instructions ? { instructions: options.instructions } : {}),
    ...(options.businessHours ? { businessHours: options.businessHours } : {}),
  });
  return { agent, provider, clock, calls };
}

/** What the host does after a successful CAS save. */
export function saved(result: TurnResult<Data>): Session<Data> {
  return { ...result.session, version: result.session.version + 1 };
}

/** A scripted `understand` reply: flow scores, mentions, extracts, branch answers and field values. */
export function understood(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return { flows: {}, mentions: {}, extract: {}, branches: {}, fields: {}, ...partial };
}

/** A scripted `speak` reply: the message plus the envelope's field values. */
export function spoken(message: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { message, ...fields };
}

export function message(text: string, id: string, extra: Partial<TurnInput<Ctx, Data>> = {}): TurnInput<Ctx, Data> {
  return { sessionId: "s1", context: ai, message: text, id, ...extra };
}

/** The scenario's shared flows. */
export const triagem = f.flow({
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
    { id: "avisa", do: "notify", with: { recipient: "leadAssignee", message: "Lead qualificado: {{data.nome}} ({{data.empresa}}), {{data.tamanho}} pessoas, {{data.urgencia}}." } },
    { id: "tchau", prompt: "Agradeça e diga que um vendedor continua daqui." },
  ],
});

export const suporte = f.flow({
  id: "suporte",
  name: "Suporte",
  description: "Quando um cliente atual tem um problema com o produto",
  on: [{ message: ["já é cliente e algo não funciona", "pede ajuda com um erro"] }],
  steps: [{ id: "p", prompt: "Peça detalhes do problema e diga que vai encaminhar." }],
});

export const retomar = f.flow({
  id: "retomar",
  name: "Retomar quem sumiu",
  on: [{ silence: "24h", if: ({ context }) => context.lead.owner === "ai" }],
  steps: [
    { id: "gate", if: { silenced: true }, then: "lembra", else: "p1" },
    { id: "p1", prompt: "Retome a conversa de forma leve: relembre o assunto em aberto e pergunte se ainda faz sentido." },
    { id: "w1", wait: "2d", else: "end" },
    { id: "p2", prompt: "Última tentativa, curta e sem pressão: fica à disposição quando quiser retomar." },
    { id: "w2", wait: "3d", else: "end" },
    { id: "n1", do: "notify", with: { recipient: "leadAssignee", message: "{{data.nome}} não respondeu a duas retomadas — vale um contato manual." }, then: "end" },
    { id: "lembra", do: "notify", with: { recipient: "leadAssignee", message: "Hora de fazer follow-up com {{data.nome}}." } },
  ],
});
