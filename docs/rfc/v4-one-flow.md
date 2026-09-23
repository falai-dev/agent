---
title: "@falai/agent v4 — one Flow (design v2)"
description: "Design record for @falai/agent 4.0: flows, automations and signals become one Flow with triggers, runs, waits and per-field asks. Not part of the docs sidebar."
type: concept
order: 99
sidebar: false
---

> **Design record, approved 2026-09-20.** This is the reference the 4.0 implementation follows.
> It came out of a read-only research pass over `@falai/agent` 3.4.5 and its three consumers
> (prospectar, atendime, ilojista), five independent designs, three judges, one synthesis, four
> adversarial critiques (90 holes) and a repair pass. Section numbers below are cited from the
> implementation plan and from commit messages as "design §N".
>
> **Decided with Gus:** scope is the framework plus all three products; all seven persistence
> adapters stay, reshaped to `Store` implementations; the host gate (`silenced`) is one mouth and
> closes `say`, `prompt` and speaking `do` steps alike; routing, mention detection and extraction
> share one `understand` call, eval-gated on Gemini and GLM before `4.0.0`.
>
> **Assumed defaults:** `maxAsks` 3; `repeat: 'once'` per session for `message` flows; zero LLM
> calls while a human owns the lead unless `silenced: { understand: true }`; lead-only events run
> in a `lead:<id>` session with `silenced: 'sem conversa'`; END_FLOW / BOT_DETECTED / SCHEDULING
> ship as `kind: 'system'` recipes; `criar_fluxo` keeps the host's generation call with
> `flowSpecSchema`; session = conversation with `anchor: 'lead'`; migrated flows get
> `onEnd: 'stay'` written explicitly.
>
> **Refined during implementation (slices 1–2, 2026-09-20):**
> - The factory is a two-step chain: `falai<C>()` returns a root whose `.fields(defs)` binds the
>   data type, and `flow` / `action` / `event` / `condition` / `agent` hang off that bound object,
>   so `collect`, `ask`, `clearOnStart` and `ctx.set` are checked against the slugs. `f.agent()`
>   passes the fields itself; `type Data = DataOf<typeof f>` replaces `InferData<typeof fields>`.
>   TypeScript cannot infer one generic while another is written by hand, which is why §3's
>   `const fields = f.fields(...)` then `f.agent({ fields })` shape was dropped.
> - Action, event and condition names inside a flow are plain strings, checked when the agent is
>   built, the same path a JSON `FlowSpec` takes. The mapped-type unions in §3 (`{ [K in keyof
>   A]: ... }[keyof A]`) would have made every flow generic in four parameters.
> - `Condition` is `{ check(ctx, arg) }` and `Action` is `{ parameters, run(params, ctx) }`, as
>   method signatures: method bivariance lets a heterogeneous map type without `any`.
> - `Store.save` returns the saved session, with the bumped version, instead of `void`.
> - A mention trigger's `extract` is a flat map of parameter definitions (`{ trecho: { type:
>   'string' } }`), the S7 form, not a JSON schema object: one shape for fields, action
>   parameters and extraction, and `toWireSchema` applies to all three.
> - Tool handlers take `(args, ctx)`, the order every provider SDK uses.
> - Prompt scaffolding (section headings, envelope instructions, routing rules) is written in
>   English; the authored content it carries (prompts, `ask` texts, instructions, knowledge) and
>   the outcome `detail` strings the host shows in *Execuções* stay in the product's language.

# @falai/agent v4 — one Flow (design v2)

## 1. Mental model

A **Flow** is a trigger plus an ordered list of steps. The trigger says when a **run** starts: the lead asks for this (`message`: the AI routes the conversation here), the lead mentions this (`mention`: the AI detects it, the run reacts beside the conversation), something happens in the host (`event` with a payload), the lead goes quiet (`silence`), or nothing — the host starts it (*Início manual*). Each step is one of five things: the AI talks (`prompt` / `collect`), a fixed message goes out (`say`), the host does something (`do`), the run waits (`wait`), or the code forks (`if`). Fields live on the agent schema, each with its own *como perguntar*; they land in any order and a step ends when its fields are known. A **session** (one per conversation) holds many runs; at most one run is asking a question at a time. One method, `agent.turn()`, takes whatever just happened, moves the runs by code, spends at most two LLM calls (understand the lead, phrase the reply) plus one per tool round, and hands back the messages to send, the timers to set and a per-step outcome line. The framework never sends, never sleeps, never saves; the host does those three things after a successful compare-and-swap. Product side: one page (*Fluxos*, sections *Funil* / *Atendimento*), one card (*Quando X → faça Y*), one editor, one assistant tool, one drawer (*Execuções*).

Child: "A flow is a list of steps that starts when something happens. The AI does the talking. The code does the rest." Junior: "`agent.turn({ message: 'oi' })` returns the messages to send."

## 2. Primitives: stays, merges, dies

| Old | Fate |
|---|---|
| Agent | Stays; immutable config, one instance serves every session. `_context`, `_pendingData`, `currentSession` die; PromptSectionCache becomes a per-turn instance (its property tests stay). `context` and `history` arrive per turn. |
| Flow | THE noun; absorbs Signal and CrmAutomation. Gains `on[]`, `anchor`, `while`, `clearOnStart`, `onEnd`. Loses `when`/`if` (→ triggers), `requiredFields`, `optionalFields`, `reentrant`, `onComplete`, `hooks`. |
| Step `prompt` / `auto` / `reply` | `prompt` stays (AI talks); `reply` → `say`; `auto` → `do`, `if`, `wait`. |
| `collect` | Stays as step completion: a talk step ends when its fields are known, skipped without a call when already known. `{ collect: [...] }` alone asks with the schema's `ask`. |
| `requires`, `skip`, `requiredFields`, `optionalFields` | Die. Order, known-field skipping, `if` steps and `maxAsks` cover every use. |
| `branches` (`when`/`if` mid-step exits) | Stay as `branches[]` on talk and `wait` steps, judged while the step is asking — `if` free, `when` inside the understand call. There is no standalone `when` step: AI forks only exist where fresh text exists. |
| `onComplete`, `reentrant` | → `onEnd` (`'end' \| 'stay' \| 'reset'`), `repeat` on the trigger, `clearOnStart`. |
| prepare / finalize / onEnter / onExit | Die → a `do` step at that position. |
| Directive, `dispatch`, `pendingDirective`, `flow.merge/validate`, five appliers | Die. Every position change goes through one `advance()`. Tools return `{ value?, data? }`. |
| Signal | → Flow with a `mention` trigger (§7). |
| CrmAutomation `trigger` | → `on[]`: `stage_entered`/`meeting_booked`/`tag_added`/`known_contact` → `event`; `stage_stagnant` → `event` + `after`; `signal` → `mention`; `conversation_idle` → `silence`; `manual` → no trigger. |
| CrmAutomation action / wait / wait_reply / condition | → `do` / `wait` / `wait` + `else` / `if`. |
| CrmAutomation `conditions`, `hopCount` | → trigger `if` as a JSON condition; `hop` rides on events and `then: { flow }`. |
| 14 actions | Host `do` actions, except `ai_message` → `prompt`, `send_whatsapp_message` → `say`, `start_automation` → `then: { flow }`. |
| StepIntegrations / flow integrations / step `media` / `initialData` | → `do` steps / `say` with `media` (`once: true` keeps "once per conversation"); `initialData` removed, no replacement. |
| `endBehavior` | → `onEnd`; *vai para outro fluxo* → `then: { flow }` on the last step. |
| `ai_message` + composer | → a `prompt` step reached by a wake. Composer deleted. |
| `haltReply` | → a `say` first in a mention flow: another run's `say` silences the floor's talk that turn. |
| behavior once/cooldown (two ledgers) | → one `claims` ledger (§5). |
| PersistenceAdapter ×7, `restoreSession`, `autoSave` | → `Store { load, save(expectedVersion) }`, `SessionConflictError`, `MemoryStore`, one `PostgresStore` reference. |
| `respondStream` | → `agent.turnStream()`. |

Core modules removed: ResponsePipeline, FlowRouter, ResponseModal, Signal*, AutoChainExecutor, StepLifecycle, DirectiveChainTracker, PersistenceManager, five adapters — about half of `src/core`. One `Runner` with one `advance()` plus `Understand.ts`, `Speak.ts`, `Envelope.ts`, `Migrate.ts`.

## 3. Public TypeScript API

```ts
import { falai, InferData, StructuredSchema, Instruction, tool } from '@falai/agent';

type Duration = `${number}${'s' | 'm' | 'h' | 'd'}`;
type Repeat = 'once' | 'always' | { cooldown: Duration };
type Template = string;                                   // {{data.x}} {{context.x}} {{input.x}}
type Next = string | 'end' | { step: string; clear?: string[] } | { flow: Template; input?: unknown };
type PredCtx<C, D, P = unknown> = { context: C; data: Partial<D>; input: P; run: Run; silenced?: string; now: Date };
type ConditionSpec<Cond> = { [K in keyof Cond]?: Arg<Cond[K]> };   // JSON form; built-ins: equals, known, silenced
type Pred<C, D, Cond, P = unknown> = ((ctx: PredCtx<C, D, P>) => boolean) | ConditionSpec<Cond>;
type Branch<C, D, Cond> = { then: Next } & ({ when: string } | { if: Pred<C, D, Cond> });

type Trigger<C, D, Cond, E> = { repeat?: Repeat } & (      // default: message/mention/silence 'once', event 'always'
  | { message: string[]; if?: Pred<C, D, Cond> }             // "o cliente pede isso"; [] = catch-all
  | { mention: string[]; extract?: StructuredSchema; if?: Pred<C, D, Cond> }   // "o cliente fala disso"; [] + if = code-only
  | { silence: Duration; if?: Pred<C, D, Cond>; businessHours?: boolean }
  | { [K in keyof E]: { event: K; if?: Pred<C, D, Cond, E[K]>; after?: Duration; businessHours?: boolean } }[keyof E]
);

type Talk<C, D, Cond> = ({ prompt: Template; collect?: (keyof D)[] } | { collect: (keyof D)[]; prompt?: Template }) & {
  ask?: Partial<Record<keyof D, string>>;                   // per-flow wording; schema `ask` is the default
  maxAsks?: number; branches?: Branch<C, D, Cond>[]; tools?: string[]; instructions?: Instruction<C, D>[];
};

type Step<C, D, Cond, A extends ActionMap, E> = { id: string; label?: string; then?: Next; ui?: Record<string, unknown> } & (
  | Talk<C, D, Cond>
  | { say: Template; media?: { slug: string }; once?: boolean }
  | { [K in keyof A]: { do: K; with: Params<A[K]>; onFail?: Next } }[keyof A]
  | { wait: Duration; businessHours?: boolean; else?: Next; branches?: Branch<C, D, Cond>[] }  // then = timed out, else = lead replied
  | { [K in keyof E]: { wait: { event: K; upTo?: Duration }; else?: Next } }[keyof E]         // then = event came, else = timed out (upTo default 30d)
  | { if: Pred<C, D, Cond>; else?: Next }                                                      // then = true, else = false (default 'end')
);

interface Flow<C, D, Cond, A extends ActionMap, E> {
  id: string; name: string; description?: string;
  on?: Trigger<C, D, Cond, E>[];        // absent or [] = Início manual
  anchor?: string;                      // 'session' (default) or a host anchor name — "vale por conversa / por lead"
  while?: Pred<C, D, Cond>;             // re-checked whenever the run moves; default = trigger `if`
  clearOnStart?: (keyof D)[];
  steps: Step<C, D, Cond, A, E>[];      // ids required, unique, never 'end'
  onEnd?: 'end' | 'stay' | 'reset';     // default 'end'
  instructions?: Instruction<C, D>[]; tools?: string[];
}

type ActionResult = { ok: true; detail?: string; spoke?: true } | { skipped: string } | { failed: string } | { defer: Duration; detail: string };
interface ActionCtx<C, D> { context: C; data: Partial<D>; input: unknown; run: Run; key: string; dedupeKey: string; silenced?: string; now: Date; set(patch: Partial<D>): void }
type ToolResult<D> = { value?: unknown; data?: Partial<D> };
```

One factory carries the only explicit generic an app writes; everything else is inferred from values.

```ts
interface LeadContext { lead: { id: string; name?: string; tags: string[]; stageId: string; assignee?: string; owner: 'ai' | 'human' }; phone: string }
const f = falai<LeadContext>();                              // falai() with no context; createAgent = falai().agent

const fields = f.fields({
  nome:      { type: 'string', ask: 'Pergunte o nome de um jeito leve, sem tom de formulário.' },
  empresa:   { type: 'string', ask: 'Pergunte de qual empresa a pessoa fala.' },
  tamanho:   { type: 'string', enum: ['1-10', '11-50', '51-200', '200+'], ask: 'Pergunte quantas pessoas trabalham lá; ofereça as faixas.' },
  urgencia:  { type: 'string', enum: ['agora', '30 dias', 'sem prazo'], ask: 'Pergunte para quando precisam resolver.' },
  orcamento: { type: 'number', ask: 'Pergunte a faixa de investimento, dizendo que é só para orientar.' },
  confirmado:{ type: 'boolean', ask: 'Resuma em uma frase o que anotou e pergunte se está tudo certo.' },  // boolean → extract: 'asked' by default
});
type Data = InferData<typeof fields>;

const actions = {
  notify: f.action({ parameters: { recipient: { type: 'string' }, message: { type: 'string' } },
    run: async (w, ctx) => { await notifications.send(ctx.context.lead, w.recipient, w.message, { key: ctx.key }); return { ok: true, detail: 'aviso enviado' }; } }),
  add_tags: f.action({ parameters: { tags: { type: 'array', items: { type: 'string' } } },
    run: async (w, ctx) => { await crm.addTags(ctx.context.lead.id, w.tags); return { ok: true }; } }),
  assign_lead: f.action({ parameters: { to: { type: 'string' } },
    run: async (w, ctx) => (await ownership.assign(ctx.context.lead.id, w.to)) ? { ok: true } : { skipped: 'lead já está com uma pessoa' } }),
  send_template: f.action({ parameters: { templateId: { type: 'string' } },
    run: async (w, ctx) => { const r = await meta.sendPaid(ctx.context.phone, w.templateId, { idempotencyKey: ctx.key });
      return r.noCredits ? { defer: '24h', detail: 'sem créditos' } : { ok: true, spoke: true }; } }),
  book: f.action({ parameters: { date: { type: 'string' }, time: { type: 'string' } },
    run: async (w, ctx) => { const ev = await agenda.create(w, { idempotencyKey: ctx.key }); ctx.set({ agenda_event_id: ev.id }); return { ok: true }; } }),
};
const events = {
  stage_entered:  f.event<{ stageId: string }>(),
  meeting_booked: f.event<{ eventId: string }>(),
  ig_comment:     f.event<{ postId: string; text: string }>(),
  reaction:       f.event<{ emoji: string }>({ direction: 'inbound' }),     // resolves reply waits, stamps lastUserAt
  human_message:  f.event<{ text: string }>({ direction: 'outbound' }),    // stamps lastAssistantAt, re-arms silence
};
const conditions = {                                                     // plus built-ins equals / known / silenced
  tagsAny: f.condition((ctx, tags: string[]) => tags.some(t => ctx.context.lead.tags.includes(t))),
  inStage: f.condition((ctx, stageId: string) => ctx.context.lead.stageId === stageId),
  channel: f.condition((ctx, kind: 'assistant' | 'campaign') => ctx.context.channel === kind),
};
```

**S1 — Triagem, complete.** The confirmation is a collected boolean; a "no" clears it and re-asks; `avisa` runs only after the lead's ok.

```ts
const triagem = f.flow({
  id: 'triagem', name: 'Triagem', description: 'Quando alguém chega querendo saber se o produto serve para a empresa dele',
  on: [{ message: ['quer saber como funciona', 'pede um orçamento', 'quer saber se serve para a empresa'] }],
  steps: [
    { id: 'quem',     prompt: 'Descubra quem é e de onde fala.', collect: ['nome', 'empresa'] },
    { id: 'porte',    collect: ['tamanho', 'urgencia'] },
    { id: 'grana',    collect: ['orcamento'], maxAsks: 2 },
    { id: 'confirma', collect: ['confirmado'] },
    { id: 'ok',       if: { equals: { confirmado: true } }, else: { step: 'quem', clear: ['confirmado'] } },
    { id: 'avisa',    do: 'notify', with: { recipient: 'leadAssignee', message: 'Lead qualificado: {{data.nome}} ({{data.empresa}}), {{data.tamanho}} pessoas, {{data.urgencia}}.' } },
    { id: 'tchau',    prompt: 'Agradeça e diga que um vendedor continua daqui.' },
  ],
});
```

**S2 — Retomar quem sumiu, complete.** Started by the silence timer the framework arms after it speaks; any reply ends the run; while a human owns the lead the seller gets a reminder instead.

```ts
const retomar = f.flow({
  id: 'retomar', name: 'Retomar quem sumiu',
  on: [{ silence: '24h', businessHours: true, if: ({ context }) => context.lead.owner === 'ai' }],
  anchor: 'lead',
  steps: [
    { id: 'gate',   if: { silenced: true }, then: 'lembra', else: 'p1' },
    { id: 'p1',     prompt: 'Retome a conversa de forma leve: relembre o assunto em aberto e pergunte se ainda faz sentido.' },
    { id: 'w1',     wait: '2d', else: 'end' },
    { id: 'p2',     prompt: 'Última tentativa, curta e sem pressão: fica à disposição quando quiser retomar.' },
    { id: 'w2',     wait: '3d', else: 'end' },
    { id: 'n1',     do: 'notify', with: { recipient: 'leadAssignee', message: '{{data.nome}} não respondeu a duas retomadas — vale um contato manual.' }, then: 'end' },
    { id: 'lembra', do: 'notify', with: { recipient: 'leadAssignee', message: 'Hora de fazer follow-up com {{data.nome}}.' } },
  ],
});

const agent = f.agent({
  name: 'Ana', provider, fields, actions, events, conditions, tools: [checkAvailability],
  flows: [triagem, retomar],
  idle: { prompt: 'Responda pela empresa; não invente preços.' },     // the one speaker that is not a step; 'silent' mutes it
  clock: () => new Date(),                                           // tests pass fakeClock
  businessHours: (at, ctx) => nextWorkingTime(at, ctx.context.lead),  // snaps, never clamps
});
```

Entry points and result:

```ts
type TurnInput<C, D, E> = {
  sessionId: string; session?: Session<D>;           // absent = first turn; a wake never creates a session
  context?: C; history?: History;                     // hosts pass history on EVERY input kind, wakes included
  silenced?: string | { reason: string; understand?: boolean };   // host gate; default zero calls, understand: true opts in
  anchors?: Record<string, { key: string; lastInboundAt?: string }>;   // { lead: { key: 'lead:456', lastInboundAt } }
  claims?: { held: Record<string, string>; active: string[] };   // dedupeKey → at; `${flowId}:${anchor}` live in other sessions
} & (
  | { message: string; id?: string; at?: string }   // hosts pass channel id + receipt time; the playground may omit
  | { wake: string }
  | { [K in keyof E]: { event: K; payload: E[K]; key: string; hop?: number } }[keyof E]
  | { start: { flow: string; input?: unknown; key: string; hop?: number } }
);

interface TurnResult<D> {
  session: Session<D>; changed: boolean;             // changed: false → save nothing
  messages: Array<{ text: string; kind: 'ai' | 'verbatim'; media?: { slug: string }; afterMs: number; key: string; runId?: string; stepId?: string }>;
  schedule: Array<{ key: string; at: Date; replaces?: string }>;   // jobId = key; at fire: turn({ wake: key })
  outcomes: StepOutcome[];
  started: Array<{ runId: string; flowId: string; anchor: string; dedupeKey: string }>;
  ended: Array<Run & { reason: 'end' | 'flow' | 'reset' | 'skipped' | 'failed' | 'replaced' }>;
  skipped: Array<{ flowId: string; anchor: string; triggerKey: string; detail: string }>;   // trigger-level, for Execuções
  llmCalls: number;
}
declare function turnStream(input: TurnInput): AsyncIterable<{ delta: string } | { done: true; result: TurnResult }>;

const r = await agent.turn({ sessionId: 'demo', message: 'oi' });   // README: one call, one obvious result
console.log(r.messages[0].text);
```

Stored flows load as `FlowSpec`: the same object as JSON with a **flat step** `{ id, kind: 'prompt' | 'collect' | 'say' | 'do' | 'wait' | 'waitEvent' | 'if', ...props, then?, else? }`, `do` names, condition names and field slugs resolved through the agent's registries. `validateFlow(spec, agent)` throws `FlowConfigurationError` naming the unknown field, action, event, condition or step id, the reserved id `end`, a missing `else` on a backward `if`, and warns on a backward edge without `clear`. `flowSpecSchema(agent)` returns FlowSpec's JSON schema with the workspace's actions (with their parameter schemas), events, conditions and fields enumerated — a closed schema Gemini accepts; it is the response schema of the host's generation call.

## 4. The turn pipeline

Eight phases, one order for every input; only 3 and 6 spend LLM calls. `turn()` does no I/O but the provider and the host's action handlers.

1. **Load** (code). Migrate a legacy blob (§10). `wake` with no session → `ignorado: sessão inexistente`, `changed: false`.
2. **Ingest** (code).
   - `message` / inbound `event`: `lastUserAt = at ?? clock()`; a keyed `id` already in `session.inputs` → no-op, `changed: false`. Every run parked on a timer `wait` with `else` takes `else` (oldest first); a `wait: { event }` on this event takes `then`.
   - Outbound `event`: stamps `lastAssistantAt`, nothing else.
   - `wake` starting with `silence:`: honored only when its `lastAssistantAtMs` equals `session.lastAssistantAt` and the lead has not written since (`lastUserAt`, and the anchor's `lastInboundAt` for lead-anchored flows, both `< lastAssistantAt`); it then goes through the start order below with `trigger.kind: 'silence'`. Otherwise `ignorado: silêncio quebrado`, `changed: false`. Any other `wake`: the run whose `waiting.key` equals it, else `ignorado: wake antigo`. A timer `wait` with `else` whose lead wrote after `waiting.setAt` takes `else` — the reply beat the job.
   - `event` / `start`: flows with a matching trigger start, in this order: `if` (payload as `input`) → `repeat` via claims (cooldown = interval check on `claims[key].at`) → `hop < 5` else `pulado: limite de encadeamento` → one active run per (flow, anchor) against `session.runs` and `claims.active`: a live run still parked on its own `after` timer is **replaced** (`ended.reason: 'replaced'`, its job self-skips), any other live run → `pulado: já em andamento` → `after` parks the new run.
   - Every run about to move re-checks `while` with fresh context; false → ends `pulado: premissa mudou`. Silence-triggered runs add the premise "no lead message since the run started" → `pulado: lead escreveu nesse meio-tempo`.
3. **Understand** (≤1 call, `schemaName: 'understand'`). Only for `message` and inbound events with text; skipped under `silenced` unless `understand: true`, and when nothing is AI-conditioned. Candidates: the floor holder's flow (always, whatever its trigger), `message` flows passing `if` + `repeat`, `mention` flows with non-empty `mention` passing `if` + `repeat`. Envelope, every property required and nullable: `{ flows: { id: 0-100 }, mentions: { id: boolean }, extract: { id: {...} }, branches: { 'runId/stepId/i': boolean }, fields: { every pending field with extract 'anywhere' } }`. Shortcuts: exactly one eligible `message` flow, no floor, no catch-all passing and `idle: 'silent'` → it starts, no scoring (with a catch-all or the idle speaker, a low score has somewhere to go, so it is scored); zero candidates and zero pending fields → zero calls (S9).
4. **Decide** (code). Runs starting this turn apply `clearOnStart` first. Extracted values are checked: unknown keys dropped (`ignorado: campo desconhecido`), strings coerced to number/boolean, enum membership enforced, otherwise `campo descartado: valor fora da lista`; then written to `session.data` (one `known`: not `undefined | null | ''`). Mention runs start in flow order (a trigger `if` with `extract` sees `input` now); `mention: []` code-only detectors start here without the call. The first true branch of the asking step takes its `then`. Routing: if a run took or resumed the floor in Ingest, routing is skipped (scores recorded, not applied). Otherwise the floor (any run `running`/`asking`, not `waiting`) stays unless another flow scores ≥ current + 15 and ≥ 40; no floor → best ≥ 40 starts (a `suspended` run of that flow resumes instead), then a `message: []` catch-all, else the `idle` speaker.
5. **Run** (code). If no run is `asking`, the most recently `suspended` returns to `asking`. The Runner advances every run that can move, oldest first, through `advance()`: `do` runs the handler with `key = ${runId}:${stepId}:${visit}` (`run.visits[stepId]` increments on entry; at-least-once, before the save); `failed` writes a `failed` outcome and continues to `then` unless `onFail`; `skipped` continues; `defer` re-parks under a fresh wake key; `spoke: true` makes it the turn's speaker. `say` appends a message (`once` → claim `${flowId}:${stepId}:${sessionId}`). `wait ≤ 10s` carries as `afterMs` to the next message emitted this turn, or schedules a real wake if none follows; longer waits park with `waiting` and a `schedule` entry, snapped by `businessHours`. `if` picks `then`/`else`. A talk step whose fields are all known is skipped (0 calls); otherwise it is queued for phase 6 and the current asker becomes `suspended` (a run started this turn by routing never suspends one that took the floor in Ingest). Flow missing from the agent → `pulado: fluxo desativado ou removido`; step missing → `pulado: passo removido`. Caps: 50 steps per run per turn → `falhou: laço de passos`; hop 5.
6. **Speak** (≤1 call + tool rounds, `schemaName: 'speak'`). One talk step speaks. Talk step = `prompt`, `collect`, `say`. Rules: a `say` or `spoke: true` emitted this turn by a run **other than** the floor holder, in reply to a user message, silences the floor's talk (`pulado: outra resposta já saiu`; the run stays `asking`) — a run's own `say` never silences its own talk. Under `silenced` no message-producing step runs and no run advances past one: an `asking` run stays `asking`; a run whose talk step was reached by a wake, event or start ends `silenciado: <reason>` (an earlier `if: { silenced: true }` routes around it); `do` steps still run; zero calls. Prompt = identity + flow + step guideline + this step's pending fields with their `ask` (all of them; the step prompt says how many to ask) + known fields as facts + tools + instructions + history. A wake states *não há mensagem nova do cliente; você fala primeiro*. Envelope `{ message, ...pending fields of this step }`, all required and nullable, shallow-merged last-wins across tool rounds. Provider failure: in phase 3 the turn throws `ProviderError` (nothing ran, nothing saved; the host retries the input); in phase 6 the turn returns with the talk step re-parked under `${runId}:${stepId}:${visit}:retry:${atMs}` (+1m, +5m, +15m), outcome `deferred: IA indisponível`, session saved, phase 5 effects not repeated.
7. **Settle** (code, the ONE applier). A collect step stays `asking` until its fields are known, a branch fires, or a field hits `maxAsks` (default 3 → `campo pulado: perguntado 3 vezes`); `asked[field]` increments when the step spoke with the field pending and the next lead message left it unknown — detours count, the ceiling is documented. A prompt without `collect` advances after speaking once. `then`: step (visits++), `{ step, clear }` (clears, then jumps), `'end'` → `onEnd`, `{ flow }` (template resolved against `input`/`context`; this run ends `reason: 'flow'`, the new run has `trigger.kind: 'flow'`, key `${parentRunId}:${stepId}:${visit}`, hop+1, and holds the floor). When no run is `asking`, the most recently suspended resumes. If the assistant spoke last, every `silence` flow passing `if` and `repeat` gets `schedule: { key: silence:${flowId}:${sessionId}:${lastAssistantAtMs}, at, replaces: <previous key> }`.
8. **Return**: `session` (version unchanged; the host bumps it), `changed`, `messages` in emission order, `schedule`, `outcomes`, `started`, `ended`, `skipped`, `llmCalls`.

Budget: message turn 2 calls + tool rounds (1 with a single flow and no pending fields, 0 when silenced); wake to a talk step 1; wake to `do`/`wait` 0. `llmCalls` on every result makes it a test, not a promise.

## 5. Waiting, timers, events

```ts
interface Run {
  id: string;                                  // `${flowId}#${triggerKey}` — deterministic, replay mints the same keys
  flowId: string; anchor: string; dedupeKey: string; stepId: string | null;
  status: 'running' | 'asking' | 'waiting' | 'suspended';
  trigger: { kind: 'message' | 'mention' | 'silence' | 'event' | 'start' | 'flow'; key: string; payload?: unknown };
  input?: unknown; hop: number; startedAt: string;
  waiting?: { kind: 'timer' | 'event'; key?: string; until?: string; setAt: string; event?: string };
  asked: Record<string, number>; visits: Record<string, number>;
  outcomes: StepOutcome[];
}
interface StepOutcome { runId?: string; flowId?: string; stepId?: string; key?: string;
  kind: 'prompt' | 'collect' | 'say' | 'do' | 'wait' | 'if' | 'idle'; status: 'ok' | 'skipped' | 'failed' | 'waiting' | 'deferred';
  detail?: string; next?: string; until?: string; at: string; llmCalls?: number }

interface Store<D> { load(id: string): Promise<Session<D> | null>; save(session: Session<D>, expectedVersion: number): Promise<void> }  // 0 = insert-if-absent; throws SessionConflictError
```

**Invariants** (docs verbatim):

- I1. The session blob is the unit of consistency: `load(v) → turn → save(expectedVersion = v)`. A losing turn is discarded and the same input replayed.
- I2. Messages, schedules, claims and ended runs leave the host's hands only after a successful save. `do` handlers are the exception: they run inside the turn, **at-least-once**, and must be idempotent on `ctx.key` (or `ctx.dedupeKey` for `once`/cooldown flows shared across a lead's sessions). `always` flows cannot be made exactly-once across sessions by the framework.
- I3. A run wake is honored only by the run whose `waiting.key` equals it; a silence wake only when the blob still shows that silence. Everything else is `ignorado`, `changed: false`. Nothing is ever cancelled; `replaces` is a best-effort hint.
- I4. Every `do` and message carries `key = ${runId}:${stepId}:${visit}`; run ids come from host keys (message `id`, event/start `key`, wake key, parent run), so a replay of the same input mints the same keys and a revisit mints new ones.
- I5. A run's claim is written in the same save as its first step; a run never exists without its claim.

**Keys.** Trigger key: `message`/`mention` → the input `id` (playground: `at`, replays not idempotent); `silence` → `lastAssistantAtMs`; `event`/`start` → the host key; `flow` → `${parentRunId}:${stepId}:${visit}`. Wake key: `${runId}:${stepId}:${atMs}`. Dedupe key `${flowId}:${anchor}:${nonce}`, nonce `''` for `once` and cooldown (blocked while `now - claims[key].at < cooldown`, else overwritten), the trigger key for `always` (last 50 kept).

**Host contract:** (a) one `turn` per session at a time; a wake queues behind a debounced inbound not yet turned. (b) On every input: fresh `context`, `history`, `anchors` (with the lead's `lastInboundAt`), `claims` for non-`always` flows, `silenced` for every "cannot speak now" reason (ownership, Pausa, closed 24h window, quota, `sem conversa`); inbound messages carry the channel `id` and `at`. (c) `changed: false` → nothing. Else one transaction: `store.save`, `started[].dedupeKey` into a unique index, `started`/`ended` into a partial unique index `(flowId, anchor) WHERE live`, `outcomes`/`ended`/`skipped` into the `flowRuns` mirror, `messages[]` and `schedule[]` into the outbox. Conflict or unique violation → discard, replay. (d) Drain the outbox: send honoring `afterMs`, record a refused send against `key` in the mirror (`enviada`/`recusada` beside the framework's `gerada`); enqueue wakes with `jobId = key`, `queue.remove(replaces)` best-effort. (e) At fire: `turn({ wake, silenced })`. (f) Call `turn` for every inbound even while a human owns the lead. (g) `businessHours(at)` snaps, never clamps. (h) Lead-level events go to the lead's latest open conversation; none → session `lead:<id>` with `silenced: 'sem conversa'`. (i) `ProviderError` → retry the input with backoff.

```ts
const clock = fakeClock('2026-09-20T10:00Z');
const agent = f.agent({ provider: mockProvider({ understand: [...], speak: [...] }), clock, fields, actions: stubs, flows: [triagem, retomar] });
let r = await agent.turn({ sessionId: 's1', message: 'oi', id: 'm1' });
clock.advance('24h');
r = await agent.turn({ sessionId: 's1', session: r.session, wake: r.schedule[0].key, history });
assert.equal(r.messages[0].kind, 'ai'); assert.equal(r.llmCalls, 1); assert.equal(r.started[0].flowId, 'retomar');
```

## 6. Field collection

`pending(step) = step.collect in order, minus known fields, minus fields at maxAsks`, computed by code; the model sees every pending field of the current step with its `ask` (step `ask` overrides the schema's). Fields are authored once: `{ type, enum?, description?, ask, extract?: 'anywhere' | 'asked' }`. `'anywhere'` (default for strings and numbers) is harvested by the understand call from any text; `'asked'` (default for booleans) only by the speak envelope of the step that lists it, so a stray "sim" never opens a code gate. `toWireSchema()` allow-lists JSON-schema keys and strips `ask`/`extract`. In the UI a field row is `{ slug, rótulo, tipo, como perguntar }`; `buildSchema(flows)` merges rows by slug and fails when two flows give one slug two types; suffix-based inference dies.

Out of order is the default. A collect step skips when its fields are known and stays `asking` until they are; a `prompt` without `collect` speaks once. Confirmation is a collected boolean behind an `if`; a correction clears it (`{ step, clear }`) and re-asks. `maxAsks` (default 3, loud in Execuções) replaces the `requires` deadlock; `maxAsks: 1` is "ask once, don't insist". `clearOnStart` (applied before this turn's extraction) replaces `reentrant`.

## 7. Signals → triggers

| Signal facet | v4 |
|---|---|
| `when[]` incl. `!` exclusions | `mention: [...]`, judged in the understand call |
| `if` | trigger `if`, free; with `extract` set it also sees `input` after the call; `mention: []` + `if` = code-only detector, no call |
| `extract` | trigger `extract` → `run.input`, `{{input.x}}`, never `data` |
| `phase: 'pre'` + `halt` + `reply` | first step `say` (or a `do` returning `spoke: true`); another run's say silences the floor that turn |
| `phase: 'post'` | dies; `do`-only mention flows run beside the reply, same turn |
| `behavior` once/always/cooldown | `repeat` → claim, one ledger, interval cooldown |
| `priority` | dies; flow order |
| `stopOtherSignals` | dies; one speaker per turn |
| handler side effects | `do` steps |

## 8. Concurrency and anchors

Session = conversation. Runs inside a session are concurrent; the floor is single: at most one run is `asking`; a talk step from another run pushes it onto a LIFO stack of `suspended` runs, and whenever nobody is asking the most recently suspended resumes. Order inside a turn: reply-branch resolutions → mention runs → floor talk; `messages[]` in that order.

Anchors are host keys per call; a flow names one or defaults to the session. Inside the session the framework dedupes; across a lead's sessions the host passes `claims.held` (nonce rule) and `claims.active` (live `${flowId}:${anchor}` pairs from its mirror) and writes both indexes in the save transaction. A lead-less campaign thread falls back to the session anchor.

S10 with versions. R1 (triagem) `asking`; R2 (retomar) `waiting` on W1. W1 fires: load v7 → premise holds → `p1` speaks (1 call) → `w1` parks, `schedule(W2)` → save v7→v8. The lead's text (id m9, at 10:00:02) lands concurrently: load v7 → save fails → replay on v8 → `w1.else` ends R2 (W2 fires stale later) → R1, still the floor, extracts and asks (2 calls) → save v8→v9. Wire: nudge, question. Had the text arrived first (or been debounced, per (a)), the wake finds `lastUserAt > setAt` → `w1.else` → no nudge.

## 9. Flow end

A run ends when `then` reaches `'end'` or the last step completes; `onEnd`: `'end'` (default; `ended[]` carries it, session idle), `'stay'` (*repete o último passo*), `'reset'` (first step, data kept). *Vai para outro fluxo* is `then: { flow }` on the last step. The framework never speaks at the boundary. A `message` flow is `repeat: 'once'` per session by default; S8 sets `'always'` + `clearOnStart`.

## 10. Persistence

```ts
interface Session<D> {
  id: string; v: 4; version: number;
  data: Partial<D>; runs: Run[];                    // live runs only
  claims: Record<string, { at: string }>;           // once/cooldown: one key per flow; always: last 50
  inputs: string[];                                  // last 50 keyed input ids
  lastUserAt?: string; lastAssistantAt?: string;
  history?: History;                                // playground only
  metadata: Record<string, unknown>;
}
```

`migrateSession(blob, { flowIdOf })` runs at each app's choke point (`deserializeFalaiSessionState`): no `v` → `data` verbatim; `currentFlow/currentStep` → one run `{ id: '${flowId}#legacy', stepId, status: 'asking', trigger: { kind: 'message', key: 'legacy' }, visits: {} }`; `signals.triggers[key]` and `flowHistory[].completed` → `claims['${flowIdOf(key)}:${sessionId}:']`; `pendingDirective` dropped. `migrateFlows` gives signal-triggered flows `id = trigger.signal` so `flowIdOf` is identity for ilojista's 315 live once-signals — a real ilojista blob is a test fixture. Talk-step ids survive, so 844 + 315 cursors keep position; split-out steps get `${stepId}:media` / `${stepId}:integration`.

## 11. Consumer migration

**One stored object.** Table `flows` (replaces `workspace.agent.flows` and `crmAutomationRules`): `id, workspaceId, name, kind ('user' | 'system'), enabled, position, section (derived), stageId?, spec JSONB`. `migrateFlows.ts`: AgentFlow → `on: [{ message: when, if: { channel } }]` from `contexts`; steps → `prompt`+`collect` (media → preceding `say` with `once`, integrations → following `do`, branches → `branches[]` on the step); `onEnd: endBehavior ?? 'stay'` (special flows `'end'`), `redirect` → `then: { flow }`; `{{lead_nome}}`-style variables rewritten to `{{context.lead.name}}` from a table; canvas positions → `ui`. CrmAutomation → `on` per §2, steps 1:1, `conditions` → trigger `if`, `haltReply` → first `say`. `defaultFlows(workspace)` (interesse, pediu_humano, known_contact → Triagem, meeting_booked → rodízio, agenda, bot_detected, conversation_ended) seeds `kind: 'system'` rows where `seedDefaultAutomationRules` runs today. The worker builds `f.agent({ flows: rows.map(r => r.spec) })` once per workspace config version.

**One editor.** *Fluxos*: *Título*, *Descrição*, *Quando ativar* (*o cliente pede isso* · *o cliente fala disso* · *acontece algo* · *silêncio do cliente* · *início manual*), *Só se*, *Vale por: conversa / lead*, *Repetição*, *Continuar só enquanto*, *Campos* with *Como perguntar*, *Ao recomeçar, esquecer*, *Ao terminar*, *Regras só deste fluxo*. Canvas *+ Adicionar passo*: *Mensagem & IA* (Enviar mensagem = `say`, IA escreve a próxima mensagem = `prompt`, Perguntar = `collect` with *Insistir até N vezes* and *Ramificação (a IA decide)* edges, Enviar modelo aprovado = `do send_template`), *Esperar* (`wait`, edges *Sem resposta* / *Respondeu*), *CRM* (`do` …, Condição = `if`, edges *Sim* / *Não*), *Equipe & integrações* (`do` …, Iniciar outro fluxo = `then: { flow }` edge). *Execuções* reads `flowRuns`: row upserted from `started[]`, status = last outcome (`Parcial` when a failed/skipped sits beside an ok), `aguardando até` from `until`, *Seguiu "Respondeu"* from `next`, trigger skips from `skipped[]`.

**One assistant tool.** `criar_fluxo({ descricao })` runs the host's generation call with `flowSpecSchema(agent)` as response schema, then `validateFlow`, then saves; `ajustar_fluxo`, `ver_fluxos`. `criar_automacao` and siblings die.

**Per app (prospectar paths; siblings identical):**

| Delete | Move | Rewrite |
|---|---|---|
| `apps/worker/src/services/crm-automation.service.ts` (1,548), `automation-message-composer.service.ts`, `conversation-idle-sweep.service.ts`, `integration.service.ts`, `utils/integration-behavior.utils.ts`, `utils/follow-up-time.utils.ts`; `apps/api/src/services/crm-automation.service.ts`, `assistant-tools/automation.tools.ts`, `backfill-scheduling-flow.ts`; `packages/server/.../scheduling-flow.utils.ts`, `signals.builder.ts`, `modules/crm/signal-rule.mapper.ts`; `contracts/.../automation.types.ts`; AgentFlow/Step/StepIntegrations/FlowEndBehavior in `agent-core.types.ts`; `apps/web/src/components/Automation/**` (4,127) | From `flow.utils.ts`: `buildStructuredKnowledgeBase` → `knowledge.utils.ts`, `buildFalaiInstructions` → `instructions.builder.ts`; the rest of the file dies. `schema.utils.ts` → 30-line `buildSchema`. `automationLabels.ts`/`automationRecipes.ts` → `flowLabels.ts`/`flowRecipes.ts`. DEFAULT_SIGNALS → `defaultFlows.ts` | `falai-agent.factory.ts` (one agent per config version, no per-turn rebuild, `buildNativeSignals`/`createStepMediaHook` gone); `ai.service.ts` (`detectFlowEndThisTurn`, `reconcilePersistedSignalState`, `pinCampaignEntryFlows` gone; `runTurn` from §12); `apps/web/src/components/Agent/**` (5,169) merged with the automation canvas into one editor (~9.3k lines of UI touched); api call sites `overview.tool.ts`, `campaign.service.ts` (followUp → `flowId`), `playground.service.ts` (`immediateAutomationActions`, `buildSignalAiEffects` → FlowSpec walkers), `agent-entity.service.ts`, `onboarding-activation.service.ts`, `automation-rule.repository.ts` → `flow.repository.ts`; `StartAutomationDialog`/`SidePanel` graph walkers ported to FlowSpec |

New host code (~1k lines): `actions.ts` (11 handlers), `wake.worker.ts`, event publishers, `migrateFlows.ts`, `defaultFlows.ts`, the transactional save. Stays host-side: the gate (→ `silenced`), channels, CRM writes inside actions, BullMQ, history building, the `flowRuns` mirror, the Instagram comment matcher.

**Framework side.** Tests: about 50 of 76 files exercise routing, directives, signals, completion, adapters or the `respond()` shape and are deleted or rewritten; ~25 kept (providers, envelope salvage, streaming decoder, tool loop, templates, history, schema, prompt-section-cache); new: `understand`, `runner`, `wakes` (fakeClock + MemoryScheduler), `events`, `session-v4` + legacy fixtures (prospectar and ilojista blobs), one file per scenario. `mockProvider({ understand, speak })` holds FIFO queues per schema name (last entry repeats) and records `.calls`. Docs rewritten in place; `docs/migration/v3-to-v4.md` with a Removed | Replacement table and the blob recipe.

## 12. Scenarios

**S1 Triage.** "oi, quero saber como funciona" (id m1) → understand scores `triagem` (1 call) → `quem` asks (1 call). "João, da Acme, somos 30" → nome, empresa, tamanho land → `quem` complete, `porte` asks only urgência. "pra ontem, quanto custa?" → urgência lands; triagem is the floor and scored; `grana` answers price from the KB and asks orçamento. Two evasions → `maxAsks: 2` → `campo pulado`. `confirma` asks; "não, somos 50" → `confirmado: false`, tamanho updated → `ok` false → `clear: ['confirmado']`, `quem`/`porte`/`grana` skip, `confirma` re-asks. "sim" → `avisa` (key `…:avisa:1`) → `tchau` → `'end'`; "obrigado" gets the `idle` reply. 2 calls per turn.

**S2 Cadence.** Assistant speaks at T → `schedule(silence:retomar:s1:T)`. Wake: premise holds → run starts (claim now) → `gate` false → `p1` speaks first (1 call) → `w1` parks. Any reply on either channel → `w1.else` → end (the anchor's `lastInboundAt` covers the other channel at the next wake). Timeout → `p2` → `w2` → `n1` (0 calls). Human owns → `gate` true → `lembra` notifies the seller, run ends.

**S3 No-show.** `turn({ event: 'stage_entered', payload: { stageId }, key: 'stage:456:T' })` → `if: { inStage: 'nao-compareceu' }, after: '1h'` parks; a re-entry replaces it. Wake → `while` holds → `prompt` + `collect: ['data_preferida', 'horario_preferido']` with agenda tools speaks first (the lead having written at T+20m does not stop it: the premise is the stage), suspends triage, collects → `do book` → host emits `meeting_booked` → *Reunião marcada* notifies. Triage resumes when no-show stops asking.

**S4 Pediu humano.** `on: [{ mention: ['quer falar com uma pessoa'], repeat: { cooldown: '1h' } }]`, steps `say 'Já chamo alguém'` → `do assign_lead` → end. The say silences triage's talk that turn; triage stays `asking`. While a human owns, `silenced` turns cost 0 calls. Handback needs no event: the next message finds triage at the same step. A second request an hour later starts a fresh run.

**S5 Campaign.** `turn({ start: { flow: 'campanha', input: { campaignId, templateId, flowId }, key } })` → `do send_template` (`spoke: true`, `defer` on no credits) → `wait '1d', else: { flow: '{{input.flowId}}' }` → timeout → `prompt` nudge → `wait '2d', else: { flow: '{{input.flowId}}' }` → end. A reply enters the campaign's own funnel, which holds the floor: routing that turn is skipped. 0 calls until the nudge.

**S6 Instagram.** `ig_comment` on the IG session → `say` DM → `wait '1d', else: 'qualifica'` → `prompt` → `then: { flow: 'agendar' }`. `anchor: 'lead'` + `claims.active` stop a second run on WhatsApp.

**S7 Rule from chat.** Same FlowSpec, same table, same card; fires inside the understand call, no talk step, runs beside the reply, once per conversation.

```json
{ "id": "concorrente", "name": "Lead falou de concorrente",
  "on": [{ "mention": ["o lead cita ou compara com um concorrente"], "extract": { "trecho": { "type": "string" } }, "repeat": "once" }],
  "steps": [
    { "id": "tag",   "kind": "do", "do": "add_tags", "with": { "tags": ["concorrente"] } },
    { "id": "avisa", "kind": "do", "do": "notify", "with": { "recipient": "owner", "message": "{{data.nome}} falou de concorrente: \"{{input.trecho}}\"" } }
  ] }
```

```ts
const criarFluxo = tool({
  id: 'criar_fluxo', description: 'Cria um fluxo a partir do que o dono pediu no chat',
  parameters: { descricao: { type: 'string' } },
  handler: async ({ descricao }, ctx) => {
    const spec = await generateFlowSpec(descricao, flowSpecSchema(agent));   // host generation call, closed schema
    validateFlow(spec, agent); await db.flows.insert(ctx.context.workspaceId, spec);
    return { value: { criado: spec.id } };
  },
});
```

**S8 Scheduling.** `on: [{ message: ['quer marcar', 'quer remarcar'], repeat: 'always' }]`, `clearOnStart: ['data_preferida', 'horario_preferido', 'agenda_event_id', 'confirmado']` (applied before "sexta às 15h" lands), collect with agenda tools, `{ collect: ['confirmado'], ask: { confirmado: 'Confirme a data e o horário em uma frase.' } }`, `do book`, last step `then: { flow: 'pos-agendamento' }`.

**S9 Config assistant.** Zero flows, zero fields → understand skipped → one speak call with tools. Interview mode: one `message` flow and `idle: 'silent'` → single-flow shortcut, no scoring; collect steps skip when known.

**S10.** §8.

**S11 Playground.** `agent.turn({ sessionId, session, message })` without `id`, `MemoryStore`, `schedule` fed to `MemoryScheduler.due(now)` or ignored; actions return `{ ok: true }`; mention flows run as no-ops and show in `started`.

**S12 AI speaks first, from a timer, mid-flow.** A `prompt` reached by a wake runs through the same agent, prompt, tools, instructions, `session.data` and the `history` the host passes; the gate arrives as `silenced`.

```ts
const propostaParada = f.flow({
  id: 'proposta-parada', name: 'Proposta parada',
  on: [{ event: 'stage_entered', if: { inStage: 'proposta-enviada' }, after: '3d', businessHours: true }],
  steps: [
    { id: 'p1', prompt: 'A proposta foi enviada há três dias sem retorno. Pergunte, em uma frase, se ficou alguma dúvida — use o que já sabe sobre {{data.empresa}}.' },
    { id: 'w1', wait: '2d', else: 'end' },
    { id: 'n1', do: 'notify', with: { recipient: 'leadAssignee', message: 'Proposta de {{data.nome}} sem resposta há 5 dias.' } },
  ],
});

wakeQueue.process(async (job: { data: { sessionId: string; key: string } }) => {
  const { sessionId, key } = job.data;
  await runTurn(sessionId, { wake: key });
});

async function runTurn(sessionId: string, input: TurnInputBody) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [session, context, history] = await Promise.all([store.load(sessionId), loadLeadContext(sessionId), loadHistory(sessionId)]);
    const anchors = { lead: { key: `lead:${context.lead.id}`, lastInboundAt: context.lead.lastInboundAt } };
    const r = await agent.turn({ ...input, sessionId, session, context, history, anchors,
      claims: await ledger.claims(anchors), silenced: await gate.reason(sessionId) });
    if (!r.changed) return;
    try {
      await db.transaction(async (tx) => {
        await store.save(r.session, session?.version ?? 0);                        // CAS, 0 = insert
        await ledger.write(tx, r.started, r.ended, r.outcomes, r.skipped);         // unique(dedupeKey), partial unique(flowId, anchor) WHERE live, Execuções
        await outbox.put(tx, r.messages, r.schedule);                              // wakes ride in the same transaction
      });
    } catch (e) { if (e instanceof SessionConflictError || isUniqueViolation(e)) continue; throw e; }
    await outbox.drain(sessionId);                                                 // send honoring afterMs, enqueue wakes jobId = key
    return;
  }
}
```

**S13 TRID script.** `[{ id: 'a', say: 'Oi! Aqui é da TRID.' }, { id: 'p', wait: '3s' }, { id: 'b', say: 'Chegou o iPhone 17, pronta entrega.' }, { id: 'q', prompt: 'Pergunte qual modelo interessa.', collect: ['modelo'] }]` → one turn, `messages: [A, B afterMs 3000, C]`; own says never silence own talk. 2 calls (understand + speak).

## 13. Risks

1. The understand call bundles routing, mentions, branches and extraction; a weak model may score routing worse than today's dedicated call. Run a scenario eval on GLM and Gemini before cutover.
2. The speak envelope with pending fields must be probed per provider (Gemini strict, Zai prompt-only); `toWireSchema()` asserts `isStrictSchema` in tests.
3. A wake-started talk step suspending a live conversation is new UX; the silence premise and `while` are the guards.
4. Dropping five adapters affects npm users beyond the three consumers.
5. Three apps migrate blobs, stored flows and ~9k lines of editor UI in lockstep with the worker rewrite; the shared FlowSpec is the chance to share one package.
6. Instruction precedence ("cara ou coroa") is untouched.
7. `do` is at-least-once before the save; a host handler that ignores `ctx.key` can double-fire on a CAS replay.