---
title: "v3 → v4 migration"
description: "What changed in v4: one Flow replaces flows, signals and automations; agent.turn() replaces respond(); fields carry their own ask; Store replaces persistence adapters; the session blob migrates once."
type: migration
order: 4
---

# v3 → v4 Migration

**Version:** 4.0.0 — One model for flows, automations and signals. `agent.turn()` takes any input (a message, a timer, a host event, a manual start) and returns the messages to send and the timers to set.

## Summary

v4 is a **clean break**. There are no aliases and no shims: every old name is gone and the new one has a different shape. A 3.x program does not compile against 4.0.

The mental model got smaller. A **Flow** is a trigger plus an ordered list of steps. The trigger says when a run starts: the customer asks for it (`message`), mentions it (`mention`), goes quiet (`silence`), something happens in your system (`event`), or you start it by hand. Each step is one of five things: the AI talks (`prompt` / `collect`), a fixed text goes out (`say`), your code does something (`do`), the run waits (`wait`), or the code forks (`if`). Fields live on the agent with their own "how to ask", land in any order, and a step ends when its fields are known.

Everything that used to live beside the framework in your app (automation rules, signal rules, follow-up schedulers, a second prompt composer) is now a flow with a different trigger. The framework never sends, never sleeps and never saves: it returns what to send and when to wake up, and you do those three things after a successful save.

Budget: a text turn costs at most two model calls (understand, then speak) plus one per tool round. Every result carries `llmCalls`.

---

## Table of Contents

1. [Entry point: `turn()` replaces `respond()`](#1-entry-point-turn-replaces-respond)
2. [`falai()` replaces `createAgent()` and the schema](#2-falai-replaces-createagent-and-the-schema)
3. [Flows: triggers replace `when`, steps get kinds](#3-flows-triggers-replace-when-steps-get-kinds)
4. [Collection: `ask` and `maxAsks` replace `requires`, `requiredFields`, `skip`](#4-collection-ask-and-maxasks-replace-requires-requiredfields-skip)
5. [Movement: `then` / `else` replace directives and hooks](#5-movement-then--else-replace-directives-and-hooks)
6. [Signals become `mention` flows](#6-signals-become-mention-flows)
7. [Timers and events: `wait`, `silence`, `event`](#7-timers-and-events-wait-silence-event)
8. [Tools return `{ value, data }`](#8-tools-return--value-data-)
9. [Persistence: `Store` replaces `PersistenceAdapter`](#9-persistence-store-replaces-persistenceadapter)
10. [The session blob: `migrateSession`](#10-the-session-blob-migratesession)
11. [Stored flows as JSON: `FlowSpec`](#11-stored-flows-as-json-flowspec)
12. [Removed → replacement](#12-removed--replacement)
13. [Codemod and verification](#13-codemod-and-verification)

---

## 1. Entry point: `turn()` replaces `respond()`

`respond({ history, session })` took one user message and returned one string. `turn()` takes whatever just happened and returns everything the host must do.

```typescript
// ─── v3 ───
const r = await agent.respond({ history, session });
await send(r.message);
await save(r.session);

// ─── v4 ───
const r = await agent.turn({ sessionId, session, context, history, message: text, id: messageId, at });
if (r.changed) {
  await store.save(r.session, session?.version ?? 0);   // throws SessionConflictError on a race: discard, replay
  for (const m of r.messages) await send(m.text, { after: m.afterMs, key: m.key });
  for (const s of r.schedule) await queue.add({ jobId: s.key, at: s.at });
}
```

Input kinds, one of: `{ message, id?, at? }`, `{ wake }` (a key from `schedule[]`), `{ event, payload, key }`, `{ start: { flow, input?, key } }`. Pass `context` and `history` on every call, wakes included. Pass `silenced: 'motivo'` whenever the assistant must not speak (a human owns the conversation, the channel window is closed, no credits): `do` steps still run, nothing is phrased, zero calls.

`respondStream()` is `turnStream()`: yields `{ delta }` chunks and one `{ done: true, result }`.

**Why:** three products built a follow-up scheduler, an automation engine and a second prompt composer around `respond()` because the framework had no notion of time or events. One entry point for every input removes all three.

---

## 2. `falai()` replaces `createAgent()` and the schema

The agent's context type is the only generic you write. Fields are declared once, with their own wording, and bind the collected-data type for everything downstream.

```typescript
// ─── v3 ───
const agent = createAgent<Ctx, Data>({
  name, provider,
  schema: { type: 'object', properties: { nome: { type: 'string', description: 'nome' } } },
  flows: [...], signals: [...], tools, instructions, knowledgeBase, persona, goal,
});

// ─── v4 ───
const f = falai<Ctx>().fields({
  nome: { type: 'string', ask: 'Pergunte o nome de um jeito leve, sem tom de formulário.' },
});
type Data = DataOf<typeof f>;

const agent = f.agent({
  name, provider, flows: [...], actions, events, conditions, tools, instructions, knowledgeBase, persona, goal,
  idle: { prompt: 'Responda pela empresa; não invente preços.' },   // speaks when no flow holds the floor; 'silent' mutes it
  clock: () => new Date(),                                          // tests pass fakeClock()
  businessHours: (at, { context }) => nextWorkingTime(at, context),  // snaps timers forward; optional
});
```

`f.flow()`, `f.action()`, `f.event()` and `f.condition()` give you typed values; `collect`, `ask`, `clearOnStart` and `ctx.set` are checked against the field slugs at compile time. Action, event and condition names inside a flow are strings and are checked when the agent is built, the same way a JSON flow is.

One `Agent` serves every session. `context`, `session` and `history` no longer live on the instance; they arrive on each `turn()`. `contextProvider`, `hooks`, `initialData`, `sessionId`, `flowSwitchMargin`, `maxAutoStepsPerTurn`, `maxDirectiveChain`, `routerMode`, `signals` and `signalBatchSize` are gone.

---

## 3. Flows: triggers replace `when`, steps get kinds

```typescript
// ─── v3 ───
{
  title: 'Triagem', when: ['quer saber como funciona', 'pede um orçamento'],
  requiredFields: ['nome', 'empresa'], reentrant: false,
  steps: [
    { id: 'quem', prompt: 'Descubra quem é.', collect: ['nome', 'empresa'] },
    { id: 'aviso', auto: true, hooks: { prepare: notifySeller } },
    { id: 'tchau', reply: 'Um vendedor continua daqui.' },
  ],
}

// ─── v4 ───
f.flow({
  id: 'triagem', name: 'Triagem',
  on: [{ message: ['quer saber como funciona', 'pede um orçamento'] }],   // repeat: 'once' per session by default
  steps: [
    { id: 'quem',  prompt: 'Descubra quem é.', collect: ['nome', 'empresa'] },
    { id: 'aviso', do: 'notify', with: { recipient: 'owner', message: 'Lead: {{data.nome}} ({{data.empresa}})' } },
    { id: 'tchau', say: 'Um vendedor continua daqui.' },
  ],
  onEnd: 'end',   // or 'stay' (repeat the last step) or 'reset' (first step, data kept)
})
```

| v3 | v4 |
|---|---|
| `title` | `id` (required, stable) + `name` |
| `when` / `if` on the flow | `on: [{ message: [...], if }]` |
| `reentrant: true` | `repeat: 'always'` on the trigger, plus `clearOnStart` |
| `requiredFields`, `optionalFields` | gone; a run ends after its last step, `onEnd` says what then |
| `endBehavior` (app-side) | `onEnd: 'end' \| 'stay' \| 'reset'`; *go to another flow* is `then: { flow }` on the last step |
| `{ reply }` step | `{ say }`, with `media?` and `once?` |
| `{ auto: true }` step | `{ do }`, `{ if }` or `{ wait }` |
| step `description` | `label` |
| `hooks.prepare` / `finalize` / `onEnter` / `onExit` / `onComplete` | a `do` step at that position |

Step ids are required and unique; `end` is reserved.

---

## 4. Collection: `ask` and `maxAsks` replace `requires`, `requiredFields`, `skip`

Out-of-order data was already the behaviour in 3.x (extraction read the whole schema); the step logic just never used it. In v4 a talk step's fields are `pending = collect − known − at maxAsks`, computed by code every turn. A step whose fields are all known is skipped with zero calls; a step stays asking until they are known, a branch fires, or a field hits `maxAsks` (default 3; the execution log shows `campo pulado: perguntado 3 vezes`).

```typescript
// ─── v3 ─── the step held position until `requires` was met; nothing collected it → deadlock
{ id: 'confirma', prompt: 'Confirme os dados.', requires: ['nome', 'empresa'] }

// ─── v4 ─── confirmation is a collected boolean behind an `if`; a "no" clears it and re-asks
{ id: 'confirma', collect: ['confirmado'] },
{ id: 'ok', if: { equals: { confirmado: true } }, else: { step: 'quem', clear: ['confirmado'] } },
```

Per-field wording lives on the field (`ask`); a step may override it (`ask: { nome: '...' }`). `extract: 'anywhere' | 'asked'` says whether a field may be harvested from any message (default for strings and numbers) or only from the reply to the step that lists it (default for booleans, so a stray "sim" never opens a gate). `{ collect: [...] }` alone asks using the field's `ask`.

---

## 5. Movement: `then` / `else` replace directives and hooks

`goTo`, `goToStep`, `complete`, `abort`, `reset`, `dispatch()`, `pendingDirective`, `flow.merge()`, `flow.validate()`, `BranchMap`, and the `Directive` type are gone. Every position change is a `then` or `else` on a step:

```typescript
type Next = string /* step id or 'end' */ | { step: string; clear?: string[] } | { flow: string; input?: unknown };
```

Branches stay on talk and `wait` steps, judged while the step is asking: `{ when: '...', then }` for the AI, `{ if: pred, then }` for code. There is no standalone AI-judged step: the model forks only where fresh customer text exists.

```typescript
// ─── v3 ───
branches: [{ when: 'quer falar com humano', then: { goTo: 'handoff' } }]
tools: [{ id: 'cancel', handler: (ctx) => ({ directive: { goTo: 'cancelamento' } }) }]

// ─── v4 ───
branches: [{ when: 'quer falar com humano', then: { flow: 'handoff' } }]
// a tool cannot move the run; give the flow an `if` step or a branch, or let the host `start` a flow
```

**Why:** five appliers implemented the same five verbs five ways. One `advance()` implements `then`.

---

## 6. Signals become `mention` flows

A signal was a detector plus a handler. In v4 it is a flow whose trigger is `mention`: the AI judges it inside the same understand call that routes the message, and the run reacts beside the conversation without taking it over.

```typescript
// ─── v3 ───
{
  id: 'concorrente', when: ['cita um concorrente', '!fala do nosso produto'], phase: 'post',
  behavior: 'once', extract: { trecho: { type: 'string' } },
  handler: ({ extracted, context }) => notify(context.lead, extracted.trecho),
}

// ─── v4 ───
f.flow({
  id: 'concorrente', name: 'Lead falou de concorrente',
  on: [{ mention: ['o lead cita ou compara com um concorrente'], extract: { trecho: { type: 'string' } }, repeat: 'once' }],
  steps: [
    { id: 'tag',   do: 'add_tags', with: { tags: ['concorrente'] } },
    { id: 'avisa', do: 'notify', with: { recipient: 'owner', message: '{{data.nome}} falou de concorrente: "{{input.trecho}}"' } },
  ],
})
```

| Signal facet | v4 |
|---|---|
| `when[]` with `!` exclusions | `mention: [...]`; write the exclusion into the phrase |
| `if` | trigger `if`; sees `input` after `extract` |
| `extract` | trigger `extract` → `run.input` → `{{input.x}}`; never written to `data` |
| `phase: 'pre'` + `halt` + `reply` | a `say` first step; another run's `say` silences the floor's reply that turn |
| `phase: 'post'` | the default: `do`-only mention flows run beside the reply, same turn |
| `behavior: once / always / cooldown` | `repeat: 'once' / 'always' / { cooldown }` |
| `priority`, `stopOtherSignals` | flow order; one speaker per turn |
| `mention: []` + `if` | a code-only detector, no model call |

`session.signals.triggers` becomes `session.claims` (see §10).

---

## 7. Timers and events: `wait`, `silence`, `event`

New in v4; nothing in 3.x maps to these.

```typescript
f.flow({
  id: 'retomar', name: 'Retomar quem sumiu',
  on: [{ silence: '24h', businessHours: true, if: ({ context }) => context.lead.owner === 'ai' }],
  anchor: 'lead',   // one active run per lead, across that lead's conversations
  steps: [
    { id: 'p1', prompt: 'Retome a conversa de forma leve.' },
    { id: 'w1', wait: '2d', else: 'end' },        // then = timed out, else = the customer replied
    { id: 'p2', prompt: 'Última tentativa, curta e sem pressão.' },
    { id: 'w2', wait: '3d', else: 'end' },
    { id: 'n1', do: 'notify', with: { recipient: 'owner', message: '{{data.nome}} não respondeu.' } },
  ],
})
```

- `wait: '3s'` (10 s or less) rides as `afterMs` on the next message of the same turn; longer waits park the run and put `{ key, at }` in `schedule[]`. Enqueue the wake with `jobId = key` and call `turn({ wake: key })` when it fires. A stale wake is ignored (`changed: false`); nothing is ever cancelled.
- `on: [{ event: 'stage_entered', after: '1h' }]` starts a run when your code calls `turn({ event, payload, key })`. Declare events with `f.event<Payload>({ direction? })`: `inbound` counts as the customer speaking, `outbound` as the assistant.
- `wait: { event: 'meeting_booked', upTo: '7d' }` parks until the event arrives.
- Runs inside a session are concurrent; at most one is asking a question. A timer-started talk step suspends the current asker and hands the floor back when it is done.

Host contract, in one line each: one `turn` per session at a time; fresh `context`, `history`, `anchors` and `claims` on every input; save + outbox + schedules in one transaction after the turn; `do` handlers run at-least-once and must be idempotent on `ctx.key`.

---

## 8. Tools return `{ value, data }`

```typescript
// ─── v3 ───
handler: async (ctx, args) => ({ data: slots, dataUpdate: { horario: slots[0] }, directive: { goTo: 'confirmar' } })

// ─── v4 ───
handler: async (args, ctx) => ({ value: slots, data: { horario: slots[0] } })
```

`value` is what the model reads back; `data` is written to the collected data. Argument order flips to `(args, ctx)`. `ToolContext` is `ToolCtx { context, data, history, run?, now }`: no `updateContext`, `updateData`, `setField`, `dispatch`. The gates (`validateInput`, `checkPermissions`, `isConcurrencySafe`, `isReadOnly`, `isDestructive`, `maxResultSizeChars`) stay. `ToolManager`, `ToolScope`, `DataEnrichmentConfig`, `ValidationConfig`, `ApiCallConfig`, `ComputationConfig` are gone.

---

## 9. Persistence: `Store` replaces `PersistenceAdapter`

```typescript
interface Store<D> {
  load(id: string): Promise<Session<D> | null>;
  save(session: Session<D>, expectedVersion: number): Promise<Session<D>>;   // 0 = insert if absent; stale → SessionConflictError
}
```

The seven adapters survive as `Store` implementations with the same client seams: `MemoryStore`, `PostgresStore`, `PrismaStore`, `RedisStore`, `MongoStore`, `SQLiteStore`, `OpenSearchStore`. They persist the v4 blob and a version, nothing else; message repositories, `SessionRepository`, `status`, `currentFlow` / `currentStep` columns, `PersistenceManager`, `autoSave`, `schemaVersion` and `restoreSession` are gone. The framework never calls a store: you `load`, `turn`, `save`.

**Use a fresh table.** The default names are the 3.x ones (`agent_sessions`, `agent:` prefix), but the columns are new, and a v4 store pointed at a live 3.x table throws `InvalidSessionError` on every load. Create the new table (`initialize()` does it for PostgreSQL, SQLite and OpenSearch), then migrate rows on first load as §10 shows.

| Store | Where a session lives |
|---|---|
| `PostgresStore`, `SQLiteStore` | one row: `id`, `version`, `blob` (JSONB / TEXT), `created_at`, `updated_at` |
| `PrismaStore` | model `AgentSession { id String @id; version Int; blob Json; createdAt DateTime; updatedAt DateTime }`, names remappable with `fieldMappings.sessions` |
| `MongoStore` | one document: `_id`, `version`, `blob` (JSON text, so claim keys with dots survive), `createdAt`, `updatedAt` |
| `RedisStore` | one hash at `${keyPrefix}session:${id}` with `version`, `blob`, `createdAt`, `updatedAt`; the compare-and-swap is one Lua script, so the client needs `hgetall`, `eval` and `quit` |
| `OpenSearchStore` | one document with `version`, `blob` (`enabled: false`, never indexed), `createdAt`, `updatedAt` |

Every store rejects a row whose blob is not a v4 session for that id, so a corrupt row is a loud error, never a fresh conversation.

---

## 10. The session blob: `migrateSession`

The 3.x `SessionState` (`currentFlow`, `currentStep`, `flowHistory`, `signals`, `pendingDirective`) becomes `Session { v: 4, version, data, runs, claims, inputs, lastUserAt, lastAssistantAt, history?, metadata }`. Migrate once, lazily, where you deserialize:

```typescript
import { migrateSession } from '@falai/agent';

const session = migrateSession(rowBlob, {
  sessionId,
  flowIdOf: (key) => key,   // signal key / old flow id → v4 flow id; identity when you kept the ids
});
```

- `data` is kept verbatim.
- `currentFlow` + `currentStep` become one run at the same step id, `status: 'asking'`, so a mid-flow conversation keeps its position. Keep your talk-step ids when you convert flows. A flow entered before its first step becomes a `running` run with no step.
- `signals.triggers[key]`, completed `flowHistory` entries and the mid-flow run itself become claims (`${flowIdOf(key)}:${sessionId}:`), so `once` flows do not fire again.
- `version` is 0: the session has no row in the v4 table yet, so your usual `store.save(session, session.version)` is the insert.
- `pendingDirective` is dropped.
- A blob that is neither v4 nor a recognisable 3.x state throws `InvalidSessionError`; a corrupt row can no longer become a fresh conversation silently.

Add a test that loads one real (anonymised) row per product and asserts the run's `stepId` and the carried claims.

---

## 11. Stored flows as JSON: `FlowSpec`

The object you store in a database is the framework's own JSON form: a `Flow` with a flat step `{ id, kind: 'prompt' | 'collect' | 'say' | 'do' | 'wait' | 'waitEvent' | 'if', ...props, then?, else? }` and predicates in JSON (`{ equals: {...} }`, `{ known: [...] }`, `{ silenced: true }`, `{ myCondition: arg }`). `fromSpec(spec)` / `toSpec(flow)` convert; `validateFlow(spec, registries)` throws `FlowConfigurationError` naming the unknown field, action, event, condition or step; `flowSpecSchema(registries)` returns the closed JSON schema to use as the response schema when you let a model write a flow.

Host actions, events and conditions are registered once on the agent and referenced by name, so a flow typed in a chat, a flow drawn in an editor and a flow written in TypeScript are the same object.

---

## 12. Removed → replacement

| Removed | Replacement |
|---|---|
| `createAgent`, `new Agent(options)` with `schema` | `falai<C>().fields(defs).agent(options)` |
| `agent.respond` / `respondStream` | `agent.turn` / `turnStream` |
| `agent.dispatch`, `pendingDirective`, `Directive`, `flow.merge`, `flow.validate` | `then` / `else` on steps |
| `Flow` class, `Step` class, `flow` namespace, `FlowOptions`, `StepOptions` | plain objects: `Flow`, `Step` |
| `title`, `when`, `if`, `reentrant`, `requiredFields`, `optionalFields`, `onComplete`, flow `hooks` | `id` + `name`, `on[]`, `repeat`, `clearOnStart`, `onEnd`, `while` |
| `requires`, `skip`, `auto`, `reply`, step `hooks`, `prepare`, `finalize` | known-field skipping, `maxAsks`, `do`, `if`, `wait`, `say` |
| `Signal`, `SignalContext`, `SignalFiring`, `signals`, `signalBatchSize`, `triggeredSignals` | `mention` flows, `repeat`, `claims` |
| `ToolContext.updateContext / updateData / setField / dispatch`, `ToolResult.dataUpdate / contextUpdate / directive`, `ToolManager`, `ToolScope`, tool config helpers | `Tool.handler(args, ctx) → { value?, data? }` |
| `PersistenceAdapter`, `SessionRepository`, `MessageRepository`, `PersistenceManager`, `SessionManager`, `restoreSession`, `createPersistedState`, `enterFlow`, `enterStep`, `completeCurrentFlow`, `mergeCollected` | `Store`, the seven `*Store` classes, `migrateSession` |
| `SessionState`, `CollectedStateData`, `SessionData` | `Session` |
| `AgentResponse.executedSteps / stoppedReason / endedFlows / appliedInstructions / isFlowComplete` | `TurnResult.outcomes / started / ended / skipped / messages / schedule / llmCalls` |
| `Template` as a function, `TemplateContext`, `ConditionEvaluator`, `ConditionWhen`, `ConditionIf`, `!` exclusions | `Template = string` with `{{data.x}}` `{{context.x}}` `{{input.x}}`; `Pred` (function or JSON) |
| `Term`, `terms` | put the glossary in `knowledgeBase` or an instruction |
| `Instruction.enabled / tags / metadata` | filter before passing |
| `promptCache`, `PromptSectionCache`, `PromptCacheConfig` | gone; every prompt is built per call. `compaction` stays and runs once per turn on the history you pass |
| `generateFlowId`, `generateStepId`, `generateToolId`, `adaptEvent`, `convertHistoryToEvents` | ids are yours; `historyToEvents` / `eventsToHistory` stay |
| `ResponseGenerationError`, `ToolCreationError`, `ToolExecutionError` | `ProviderError` (provider failures), `FlowConfigurationError` (bad config); a failing speak call re-parks the step instead of throwing |

Providers (`GeminiProvider`, `OpenAIProvider`, `AnthropicProvider`, `OpenRouterProvider`, `DeepSeekProvider`, `ZaiProvider`, `FallbackAiProvider`, `OpenAICompatibleProvider`, `ProviderAdapter`) and the `AiProvider` seam are unchanged.

---

## 13. Codemod and verification

Find every site to touch:

```bash
rg -n "createAgent|\.respond\(|respondStream|dispatch\(|pendingDirective|goTo|requiredFields|optionalFields|requires:|reentrant|auto: true|reply:|signals:|Signal<|phase: '(pre|post)'|PersistenceAdapter|restoreSession|SessionState|updateData|dataUpdate|directive" src
```

Then, in this order: convert stored flows and signal rules to `FlowSpec` rows (keep talk-step ids; give migrated signal flows `id = signal key`); register your actions, events and conditions on the agent; replace the `respond` call site with load → `turn` → transactional save + outbox + schedules; wire wakes (`jobId = key`, `turn({ wake })` at fire time) and host events; put `migrateSession` in your deserializer and make it throw on garbage; delete the automation engine, the follow-up sweep and the second composer.

Check:

```bash
bun run typecheck
bun test
rg -n "respond\(|dispatch\(|requiredFields|Signal<|goTo" src   # nothing left
```

Then play four scenarios in your playground before deploying: a triage that collects out of order, a silence follow-up firing from a fake clock, a mention flow that speaks first and hands the floor back, and a `say` / `wait: '3s'` / `say` chain arriving as two messages with a delay.
