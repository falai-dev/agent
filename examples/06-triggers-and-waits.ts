/**
 * Triggers and waits: flows that start without a message, and steps that
 * pause.
 *
 * Teaches: `f.action`, `f.event`, `f.condition`; `silence`, `event` +
 * `after`, `mention` + `extract`, manual `start`; `wait` with `else`,
 * `wait: { event }`; the host loop over `schedule[]` and `turn({ wake })`;
 * an injected `clock`.
 * Read next: docs/concepts/runs-and-waits.md
 *
 * Run: GEMINI_API_KEY=... bun run examples/06-triggers-and-waits.ts
 */

import { falai, GeminiProvider, type ScheduleEntry } from "@falai/agent";

interface Ctx {
  lead: { id: string; nome?: string; etapa: string; dono: "ia" | "humano"; tags: string[] };
}

const f = falai<Ctx>().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});

const actions = {
  avisar: f.action({
    parameters: { para: { type: "string" }, texto: { type: "string" } },
    run: (params, ctx) => {
      // Runs at least once per `ctx.key`; make real handlers idempotent on it.
      console.log(`[avisar ${ctx.key}] ${params.para}: ${params.texto}`);
      return { ok: true };
    },
  }),
  etiquetar: f.action({
    parameters: { tags: { type: "array", items: { type: "string" } } },
    run: (params) => {
      console.log("[etiquetar]", params.tags);
      return { ok: true };
    },
  }),
};

const events = {
  entrou_na_etapa: f.event<{ etapa: string }>(),
  reuniao_marcada: f.event<{ quando: string }>(),
};

const conditions = {
  naEtapa: f.condition((ctx, etapa: string) => ctx.context.lead.etapa === etapa),
};

// Nudge whoever went quiet. Started by the timer the framework arms after it speaks.
const retomar = f.flow({
  id: "retomar",
  name: "Retomar quem sumiu",
  on: [{ silence: "24h", businessHours: true, if: ({ context }) => context.lead.dono === "ia" }],
  anchor: "lead", // one live run per lead, across that lead's conversations
  steps: [
    { id: "p1", prompt: "Retome a conversa de forma leve e pergunte se ainda faz sentido." },
    // `then` (implicit: next step) = two days passed; `else` = the lead replied.
    { id: "w1", wait: "2d", else: "end" },
    { id: "p2", prompt: "Última tentativa, curta e sem pressão." },
    { id: "w2", wait: "3d", else: "end" },
    { id: "n1", do: "avisar", with: { para: "vendedor", texto: "{{context.lead.nome}} não respondeu a duas retomadas." } },
  ],
});

// An hour after entering the proposal stage, if still there, speak first and wait for the meeting.
const proposta = f.flow({
  id: "proposta",
  name: "Acompanhar proposta",
  on: [{ event: "entrou_na_etapa", after: "1h", if: { naEtapa: "proposta" } }],
  while: { naEtapa: "proposta" },
  steps: [
    { id: "fala", prompt: "Pergunte se a proposta chegou bem e se há dúvidas." },
    { id: "espera", wait: { event: "reuniao_marcada", upTo: "7d" }, else: "lembra" },
    { id: "ok", do: "etiquetar", with: { tags: ["reunião marcada"] }, then: "end" },
    { id: "lembra", do: "avisar", with: { para: "vendedor", texto: "Sem reunião em 7 dias." } },
  ],
});

// A mention reacts beside the conversation; it never takes it over.
const concorrente = f.flow({
  id: "concorrente",
  name: "Falou de concorrente",
  on: [{ mention: ["cita ou compara com um concorrente"], extract: { trecho: { type: "string" } } }],
  steps: [
    { id: "tag", do: "etiquetar", with: { tags: ["concorrente"] } },
    { id: "avisa", do: "avisar", with: { para: "vendedor", texto: 'Falou de concorrente: "{{input.trecho}}"' } },
  ],
});

// No `on`: the host starts it with `turn({ start })`.
const boasVindas = f.flow({
  id: "boas-vindas",
  name: "Boas-vindas",
  steps: [{ id: "oi", say: "Oi! Vi que você se cadastrou. Posso ajudar em algo?" }],
});

// A clock you control: tests and this demo move time by hand.
let now = new Date("2026-09-21T10:00:00-03:00");

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  actions,
  events,
  conditions,
  flows: [retomar, proposta, concorrente, boasVindas],
  clock: () => now,
  // Snap a timer forward to working hours; never clamp it backwards.
  businessHours: (at) => {
    const d = new Date(at);
    if (d.getHours() >= 18) d.setHours(33, 0, 0, 0); // 9h next day
    if (d.getHours() < 9) d.setHours(9, 0, 0, 0);
    return d;
  },
});

// ─── The host loop ─────────────────────────────────────────────────────────
// Real hosts persist `session`, enqueue each `schedule[]` entry with
// `jobId = key`, and call `turn({ wake: key })` when it fires. Here we keep
// them in memory and jump the clock.

const context: Ctx = { lead: { id: "456", nome: "Ana", etapa: "proposta", dono: "ia", tags: [] } };
const timers: ScheduleEntry[] = [];

let r = await agent.turn({ sessionId: "s1", context, start: { flow: "boas-vindas", key: "signup:456" } });
console.log(r.messages.map((m) => m.text)); // [ 'Oi! Vi que você se cadastrou. ...' ]
timers.push(...r.schedule); // the silence timer, if `retomar` is eligible

r = await agent.turn({
  sessionId: "s1",
  session: r.session,
  context,
  event: "entrou_na_etapa",
  payload: { etapa: "proposta" },
  key: "stage:456:proposta",
});
timers.push(...r.schedule); // the `after: '1h'` wake for `proposta`

// Fire the earliest timer.
timers.sort((a, b) => a.at.getTime() - b.at.getTime());
const next = timers.shift();
if (next) {
  now = next.at;
  r = await agent.turn({ sessionId: "s1", session: r.session, context, wake: next.key });
  console.log(r.started.map((s) => s.flowId), r.messages.map((m) => m.text), `chamadas: ${r.llmCalls}`);
}
