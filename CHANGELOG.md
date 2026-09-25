# Changelog

All notable changes to `@falai/agent` will be documented in this file.

## [4.0.0]

One model for flows, automations and signals. The migration guide is [docs/migration/v3-to-v4.md](./docs/migration/v3-to-v4.md); this entry is its summary.

### Changed (BREAKING)

- **A Flow is now a trigger plus an ordered list of steps, and it is the only primitive that starts work.** Three products built the same three things around the framework because it had no notion of time or events: a follow-up scheduler, an automation engine with its own run ledger, and a second prompt composer for messages the framework could not phrase. All three are flows now. `on[]` says when a run starts: the customer asks for it (`message`), mentions it (`mention`, the old Signal), goes quiet (`silence`), something happens in the host (`event`, with `after` and `businessHours`), or nothing (the host calls `start`). A step is one of five things: the AI talks (`prompt` / `collect`), a fixed text goes out (`say`), the host does something (`do`), the run waits (`wait`), or the code forks (`if`). `title` → `id` + `name`, `when`/`if` on the flow → triggers, `reentrant` → `repeat` + `clearOnStart`, `endBehavior` → `onEnd: 'end' | 'stay' | 'reset'`, `reply` → `say`, `auto` → `do` / `if` / `wait`, every hook → a `do` step at that position.

- **`agent.turn()` replaces `respond()`; it takes any input and returns everything the host must do.** `{ message }`, `{ wake }`, `{ event, payload, key }` or `{ start }` go in; `messages[]` (with `afterMs` and a deterministic `key`), `schedule[]` (wake keys and times), `outcomes[]` (one line per step for the execution log, each with a stable `code`), `started`, `ended`, `skipped` and `llmCalls` come out. The framework never sends, sleeps or saves. `context` and `history` arrive on every call; the instance holds no session, so one `Agent` serves every conversation and the per-turn rebuild consumers did is gone. `silenced: 'motivo'` is the one gate: `do` steps still run, nothing is phrased, zero model calls. `respondStream` is `turnStream`.

- **Fields are declared once, with their own wording, and land in any order.** `falai<C>().fields(defs)` binds the data type for every `collect`, `ask`, `clearOnStart` and `ctx.set` downstream; `type Data = DataOf<typeof f>`. A field is `{ type, enum?, description?, ask?, extract?: 'anywhere' | 'asked' }`. A talk step's pending set is `collect − known − at maxAsks`, computed by code every turn, so a step whose fields are already known is skipped with no call and a step asks until they are known, a branch fires, or `maxAsks` (default 3) trips. `requires`, `skip`, `requiredFields` and `optionalFields` are gone: `requires` deadlocked whenever nothing collected the field, and the other three were never used by a consumer. Booleans default to `extract: 'asked'`, so a stray "sim" never opens an `if`.

- **Movement is `then` / `else` on a step. Nothing else moves a run.** `goTo`, `goToStep`, `complete`, `abort`, `reset`, `dispatch()`, `pendingDirective`, `flow.merge()`, `flow.validate()` and the `Directive` type are gone; five appliers implemented the same five verbs five ways, and two of the verbs were no-ops. `Next` is a step id, `'end'`, `{ step, clear }` or `{ flow, input }`. Branches stay on talk and `wait` steps, judged while the step is asking. Tools return `{ value?, data? }` and take `(args, ctx)`.

- **At most two model calls per text turn.** One `understand` call routes the message, detects mentions, judges branches and extracts fields in a single envelope; one `speak` call phrases the reply with the step's pending fields, plus one call per tool round. Today's pipeline spent two to four calls before the reply. A single eligible flow with no floor holder routes without a call; a `wake` to a `do` or `wait` step costs none. Every result carries `llmCalls`, so the budget is a test, not a promise.

- **`Store { load, save(session, expectedVersion) }` replaces `PersistenceAdapter`.** The seven adapters survive as `MemoryStore`, `PostgresStore`, `PrismaStore`, `RedisStore`, `MongoStore`, `SQLiteStore` and `OpenSearchStore`, persisting the v4 blob and a version; message repositories, `SessionRepository`, `PersistenceManager`, `autoSave` and `restoreSession` are gone. The framework never calls a store: `load`, `turn`, `save`, and a stale version throws `SessionConflictError` so the same input is replayed. The session blob is `{ v: 4, version, data, runs, claims, inputs, lastUserAt, lastAssistantAt }`; `migrateSession(blob, { sessionId, flowIdOf })` turns a 3.x `SessionState` into it once, keeping `data` verbatim, the current step as one `asking` run, and once-fired signals as claims, and throws on a blob it does not recognise instead of yielding a fresh conversation.

- **Stored flows are the framework's own JSON.** `FlowSpec` is a flow with flat `{ id, kind, ... }` steps and JSON predicates; `fromSpec` / `toSpec` convert, `validateFlow` names the unknown field, action, event, condition or step, and `flowSpecSchema` returns the closed schema to hand a model that writes flows. Host actions, events and conditions register once on the agent and are referenced by name, so a flow typed in a chat, drawn in an editor or written in TypeScript is the same object.

- **Import surface.** The package exports `falai`, `Agent`, the seven stores, `migrateSession`, the `FlowSpec` helpers, the providers, the history helpers, the error classes and the types. Everything not on that list is gone, without aliases. The `rg` line in the guide finds every call site.

- **`promptCache` and `PromptSectionCache` are gone.** Every prompt is built per call from that turn's request, so there is nothing to memoize across turns. The providers' own prompt caching (Anthropic, OpenRouter sticky routing) is untouched. `compaction` stays and now runs once per turn, on the history the host passes, before either model call; a summarization counts as one `llmCalls`.

- **Outcome lines carry a code, not a sentence.** Every `StepOutcome` and every `TurnResult.skipped` entry now has `code`, one of 38 stable values (`already-known`, `stale-wake`, `max-asks`, `provider-unavailable`, …), plus `message`, the English sentence the framework copies from `OUTCOME_MESSAGES`. Switch on `code`: it survives a rewording, and a product renders it in its own language. `detail` is now only ever text someone else wrote: your `silenced` reason, an action's own words, or the field a line is about. The Brazilian Portuguese strings that used to fill `detail` are gone from the package; a product that wants them maps the code to its own copy. Two lines also got more useful: `max-asks` and `unknown-field` now name the field in `detail`.

### Added

- **A flow lists the data it needs; its steps say what to ask, and when.** `Flow.collect` names the agent fields the flow needs. The definitions stay on the agent. A talk step's `collect` is now "what to ask next, in this order", one field or several. Products wanted the data owned by the flow, because scheduling needs one set and triage another. Before, a field the flow needed but no step asked had nowhere to live. The understand call now reads every unknown `'anywhere'` field on the flow's list, while the flow holds the conversation or could take it. When nobody holds it, the catch-all (`message: []`) is read too, so a flow that catches every first message learns everything the opening message already says. The fields the catch-all's first step asks are read by that step's own speak call, so an opening message with nothing else to learn still costs one call. `validateFlow` checks the slugs. It also warns about a field on the list that only an answer can fill (`extract: 'asked'`, every boolean by default) when no step asks it.

- **A collect step can ask with fixed text: `question`.** The first ask goes out word for word as a `verbatim` message, with no model call and `code: 'asked-fixed'`. It goes out only when every field the step collects is still missing and none was asked yet, and never on a run that stays (`onEnd: 'stay'`). Every later ask is the model's own wording, so a customer who asks something back still gets an answer. `validateFlow` rejects a `question` on a step with nothing to collect. For a fixed message with no question, use a `say` step.

- **`{ step, clear }` also resets the ask count of the fields it clears.** Clearing means "ask this again from scratch", so the fixed question goes out again. A confirm loop that clears and jumps back no longer hits `maxAsks` after three rounds.

- **`FieldDef.label`: the name a person reads.** Editors and handoff notes can show "Orçamento" instead of `faixa_investimento`. The model never sees it, because the wire schema lists only the keys it sends.

- **`agent.pendingWakes()` says what a saved session is waiting on.** Silence wakes exist only in the host's queue: the framework arms one at the end of a turn where the assistant spoke, and nowhere else. So a flushed Redis dropped every follow-up for good, and so did a cutover from 3.x, whose blobs carry no `lastAssistantAt`: a conversation quiet at the switch never got its nudge. `pendingWakes({ session, context, anchors?, claims? })` returns every wake the session waits on, each parked run's and each silence flow's counted from `lastAssistantAt`, with the trigger's `if` and `repeat` judged as in a turn. It changes nothing and spends no call. At a cutover, set `lastAssistantAt` from your messages table after `migrateSession`, then enqueue what it returns.

- **A trigger phrase that opens with `!` rules the trigger out instead of firing it.** Phrases are alternatives, so a list alone can only say "any of these" — and the accuracy of a real classifier rests on being able to say "but not this". A customer answering "pode sim" to an offer of a meeting is agreeing to the meeting, yet that sentence does mention a person, so a handoff detector without exclusions fires on every cheerful yes. v3 had this as documented `ConditionWhen` syntax and v4 dropped it, which silently turned each exclusion into one more reason to fire. Now `message` (an exclusion scores the flow 0), `mention` (an exclusion answers false) and an instruction's `when` (`never when: …`) each reach the model as two lists, with the exclusions stated to override a match. A `!` anywhere but the first character is ordinary text, a bare `"!"` is ignored, and `validateFlow` rejects a trigger whose phrases are all exclusions, because nothing could ever match it — `message: []` is still how a flow catches everything else.

- **A field the host knows is blank no longer leaves a hole in the sentence.** `{{...}}` had one rule: a path that resolved to nothing kept its braces. That is right for a typo and wrong for a blank value, because an optional field the host fills with `''` is not a mistake — it is a lead with no company. Those two cases are now separate. An unknown path still keeps its placeholder; a blank one drops out and takes the gap with it, so `"Ola {{context.lead.name}}, tudo bem?"` sends `"Ola, tudo bem?"` and never `"Ola , tudo bem?"`. The tidy is narrow on purpose — a doubled space after a visible character, a space before punctuation, a space at the end of a line — and it runs only on a string where something actually came back blank, so indentation in a list and an author's own double space survive untouched. v3 did this and v4 had dropped it; the products that render a lead into their copy need it.

  Two things count as blank. An empty string, and a path that walks **through** a `null`: `context.lead` being `null` says there is no lead, so "the lead's name" is blank rather than mistyped, and a host does not have to choose between a nullable object its conditions read and copy that renders. A `null` at the *end* of a path is still unknown — a field that collected nothing keeps its braces — and a container that is simply missing (`{{context.leed.name}}`) still keeps them too, which is the typo the rule exists for.

- **`validateFlow` rejects a trigger that names no kind, and a step that does nothing.** Both used to pass and then fail invisibly. An `on[]` entry is a trigger because it carries `message`, `mention`, `silence` or `event`; anything else — the v3 `{ kind: 'message', when: [...] }` shape, or a typo in that one key — survived `fromSpec` as written, never matched in the Runner, and left a flow that simply never fired with nothing anywhere saying why. The same for a step with no `prompt`, `collect`, `say`, `do`, `wait` or `if`: the run walked straight past it. Naming the unreachable thing is what `validateFlow` is for, so it now throws on both, saying which trigger or step and what a real one looks like.

- **A wrong-type parameter error reads "an integer" and "a list of strings".** `describeDef` glued the article on by concatenation, so the one vowel-initial scalar type came out as "a integer" and an array as "a list of string" — in the very sentence that tells whoever wrote the flow what to type instead.

- **`history` is the conversation BEFORE this input, and the docs now say so.** Both calls quote the customer's message on its own ("Customer's latest message"), so a host that stores the message first and then passes the stored history makes the model read it twice. The type and both docs said only "the conversation so far", and three ports split on it: the worker left the message out, while every playground and site chat put it in. The contract is now written where a host reads it: leave the message this turn carries out of `history`, and store it after the turn.

- **`TurnResult.usage` says what the turn's model calls cost.** `{ promptTokens, completionTokens, cachedInputTokens }`, the providers' own counts added up over the understand call, the speak call, every tool round and a compaction summary — the figure a host bills a conversation from. It sits beside `llmCalls` and is absent, never zero, when a turn spent no call or the provider reported no counts.

### Docs and tooling

- **The docs are rewritten for v4**: a five-page tutorial, twelve task guides, four concept pages (the model, the turn, runs and waits, collection) and one reference page per public type, including the full outcome-code table a product team needs to build an execution log. The pages about directives, signals, `createAgent` and persistence adapters are gone with the things they described.

- **`bun run check:docs`** typechecks every TypeScript fence in `README.md` and `docs/` as its own file against `src/index.ts`, so a snippet cannot drift from the API. A fence that shows a shape opens as ` ```ts fragment ` and is skipped. It runs in `prepublishOnly`.

- **`bun run eval:live`** runs eight checks that only a real provider can answer — the envelope parses, fields land and an enum snaps, a tool round completes, deltas stream, the system half is read, a repeated prefix is billed as a cache read, a bad key classifies as `auth`, an oversized prompt as `context` — against every provider whose key is in the environment. `--only zai`, `--skip cache`.

- **`bun run eval:understand`** replays 40 labelled Brazilian Portuguese messages through a real agent on every provider whose key is in the environment, with the speak call silenced so only the understand call runs. It reports how often the call agrees with the labels on routing, mentions and extraction, plus tokens and latency, and fails below `--min` (default 0.9). One call now does what 3.x spread over two to four.

### Fixed

- **`probeJsonWithTools()` measures the adapter's own model, not its fallback chain.** It asked through the chain, so a call the primary refused (a flat-rate plan's 429, say) was answered by the next model, and that model's answer set the primary's `jsonWithTools`. One unchanged Z.ai model logged four different verdicts on four boots. A primary that fails the probe now throws. Each fallback is an adapter of its own, so probe each one the same way. It needs `@providerkit/core` 0.11.2, whose probe also makes its calls one at a time.
- **An `onEnd: 'stay'` flow keeps answering when its last step collects.** A stay run re-entered its last step, and a collect step with every field known is skipped with no call. So once the lead gave the last field, the run sat on that step, skipped it on every message, and held the conversation, so the idle speaker never answered either. The assistant went quiet for good. The same happened when the last step was a `do` or a `say`: the run parked on a step that never talks. Now `'stay'` goes back to the last talk step the run took (on a branched flow, the one on its own path) and answers every message from there, with a new key each time, even with nothing left to collect. The steps after that talk step run once, on the way to the end. An `if` branch of that step that leads to `'end'` or to a step the run has already been through is not taken again, since the fact it tests would hold on every message and run that path each time; one that leads elsewhere, like a handoff to another flow, still fires. `max-asks` is reported once, not on every answer. If the run finishes on a message nothing has answered yet, the talk step answers it in that same turn; a `say` or a `spoke: true` on the way counts as the answer. A run that finishes while another run is asking waits `suspended` behind it instead of asking beside it. A run the message belongs to (routed to it, or a reply that resolved its `wait`) takes the conversation instead and suspends the other asker, even when a `say` was the answer; the suspended asker does not also ask again in that turn. A reply that brings a run back to its stay step gets that step's `when` branches judged. A field still pending on the stay step is asked for on each answer, each with its own key, and its `max-asks` is reported once. A flow edited off `'stay'` applies its new `onEnd` to a staying run on that run's next message. A talk step with no `prompt` and nothing left to collect is told to answer the customer, not to collect. A flow with no talk step ends, as with `'end'`. `Run.staying` marks such a run; `assertSession` keeps it. A run the old `'stay'` left on a collect step answers the lead's next message, with no data change. One it left on a `do` or `say` step runs that step once more, with a new key, and then answers.
- **A suspended run answers the message its asker moved on from without a word.** When the asker finished silently (its last field came in the understand call and its tail was all `do` steps, say), nothing answered: the idle speaker did, or nobody with `idle: 'silent'`, and the suspended run only went back to asking after the turn. Now, on a message nothing has answered once every run has moved, the most recently suspended run resumes and answers it in the same turn, and if it too moves on without a word the next one down the stack does. A run that resumes on a message has its step's `if` branches judged first, as the asker's are, so a branch that holds is taken instead of the step moving on past it.
- **A `mention` flow that chains no longer takes the floor from the routed run.** A child started by `then: { flow }` took the floor whatever its parent was, so a mention flow chaining on the side took the message from the flow the router picked. The child now inherits the floor only from a parent that held it, or when no run did.
- **An event flow with `businessHours: true` and no `after` waits for working hours.** The snap ran only on the `after` wake, so a flow that should start at once but only during working hours started at 3 a.m. all the same, and its first `say` went out then. A lead moved into a stage overnight got the message overnight. With no `after`, the start now snaps through the agent's `businessHours`: inside working hours the run starts at once, as before; outside them it parks with `code: 'awaiting-trigger'` and the usual `${runId}:start:${atMs}` wake.
- **The docs no longer tell you to use a wake key as a BullMQ job id.** Seven places said `jobId = key`. BullMQ refuses a custom id that contains `:` unless it splits into exactly three parts, and a silence key has four (`silence:<flow>:<session>:<ms>`), as do a provider-retry key and any timer in a flow an event started. The add throws, and a host that logs and moves on loses every follow-up without a sound. The docs now say to put the key in the payload and use `encodeURIComponent(key)` as the job id, for `replaces` too.
- **A parameter value that is not one of its listed values says which ones are.** `validateFlow` checked `enum` but worded a miss as a type error, so a webhook `method: "FETCH"` was refused with "must be a string, got string". It now reads `must be one of "GET", "POST", got "FETCH". Use one of the listed values.`, and for a list parameter it names the first item that is off the list. A wrong type still reads as before.
- **A lone message flow no longer takes every message.** The router started the only eligible `message` flow without asking the model, since there was nothing to compare it with. But a low score does have somewhere to go: the first `message: []` catch-all, or the idle speaker. So an agent whose one phrased flow was "end of conversation" said goodbye to every "oi", and a campaign's catch-all lost the message whenever a single built-in flow was also eligible. A lone flow is now scored like any other. It starts unscored only when no catch-all passes and `idle` is `'silent'`, where a low score would leave the customer with no reply. The cost is one understand call on a message that used to spend none, in an agent with one phrased flow and the idle speaker on; most such turns already spent it extracting a field.

- **A tool call whose arguments were cut mid-stream no longer runs with nothing.** The adapter parsed the assembled argument string strictly, and a stream that ended early — a model at its `max_tokens`, a gateway that double-escaped — left the tool running on `{}`: a lookup with no id, a send with no recipient, behind one warning. The arguments are now salvaged, so a cut value arrives short instead of absent, and the tool's own `validateInput` decides whether that is enough.

- **The reasoning behind a tool call rides back to the model.** Thinking providers reject an assistant turn that made a tool call and came back without its own chain of thought, which is the default path here: `ZaiProvider` fronts a GLM thinking endpoint. `AssistantHistoryItem` now carries `reasoning` and `reasoningDetails`, the framework fills them on its own tool rounds, and the OpenAI-shape adapters replay them. Anthropic-shape drops them on purpose — its thinking blocks are signed.

- **A provider failure now says which wall it hit, and a wall that never moves ends the step.** Every throw from the speak call became one code and one ladder: `provider-unavailable`, re-parked at +1m, +5m, +15m, and then +15m forever — two model calls a wake, for as long as the session lived, against a wrong API key or a prompt past the context window. The failure is now classified (`provider-auth`, `provider-quota`, `provider-context`, `provider-invalid`, `provider-unavailable`), only the kinds a wait can fix are retried, the ladder is finite (1m, 5m, 15m, 1h, 6h) and then the run ends `failed`, and a provider that states when its limit reopens (`retry-after`, a plan window) is woken then instead.

- **The stable half of the prompt is sent as a system message, so providers can cache it.** Identity and the knowledge base went in the same string as the turn's own text, which put a cache breakpoint on a prefix that changed every turn: on Anthropic and Z.ai the cache was written every call and never read. They now travel as `system`, and only text that interpolates `{{data}}` or `{{context}}` stays inline, where it belongs. Measured on Z.ai, a second turn on the same agent read 704 of 2,546 prompt tokens from cache; on OpenRouter, 6,656 of 14,845; on DeepSeek, 13,824 of 16,055.

- **DeepSeek asks for JSON mode, not a schema.** `DeepSeekProvider` sent `response_format: { type: 'json_schema' }`, which DeepSeek answers with `400 "This response_format type is unavailable now"` — so every call failed and the provider had never worked. It now sends `{ type: 'json_object' }` with the schema in the prompt, which is the path the parser already tolerates, and reports `supportsNativeJsonSchema: false`.

- **A tool whose `parameters` is not a JSON Schema object is rejected at build.** A function declaration needs `{ type: "object", properties, required }`; an action's shorthand map (`{ cidade: { type: "string" } }`) reads as valid TypeScript and is not one. DeepSeek answered it with a 400; every other provider accepted the declaration and simply never called the tool, with nothing logged. `f.agent()` now throws `FlowConfigurationError` naming the tool.

- **A provider that says "don't retry" is believed.** The retry ladder read only the failure's kind, so a `503` carrying `x-should-retry: false` — the one answer nobody has to infer, and the one `@providerkit/core` already puts above its own transience test — was re-parked five times and cost ten model calls before the run ended. It is now read first, in both directions: a transient kind that says don't ends the step, and a kind the framework calls final that says do gets its wake.

- **Gemini 2 with tools works again, through `@providerkit/core` 0.11.1.** On that generation a response schema and a tool declaration cannot ride the same call — `400 "Function calling with a response mime type: 'application/json' is unsupported"` — and core sent both anyway, so every tool-carrying call to a 2.x model failed outright. Core now puts the schema in the prompt there, the one way it can travel; Gemini 3 still gets the enforced schema. The floor moved to `^0.11.1` for it.

- **A tool round no longer opens the conversation with the assistant.** The tool call and its result were appended to the host's history, and the composed prompt was sent after them — so on a first turn, where the host has no history yet, the model's own `functionCall` was the first thing in the request. Gemini refuses that outright (`400 "function call turn comes immediately after a user turn or after a function response turn"`), so every tool round on a new conversation ended with no answer; the OpenAI-shape providers accepted the same malformed order silently. The customer's message is now the turn the call answers, and a wake — where nobody spoke — uses the prompt.

- **A fenced envelope no longer streams raw JSON to the customer.** A schema the model is merely asked for, which is how one rides on any call that also carries tools, comes back inside a ```` ```json ```` fence from some models. The non-streaming parser strips that fence; the streaming decoder did not, so it read the whole block as plain text and passed it through delta by delta. It now skips a leading fence, and holds text back while one may still be opening rather than guessing.

- **An unregistered action names itself.** `detail` read `ação desconhecida`; it now reads `unknown action "notify"`, matching the wording `FlowConfigurationError` already uses for the same mistake at build time. `validateFlow` still rejects it long before a turn runs.

- **The retry wake answers the customer's question.** After a provider failure, the retry wake spoke with the "you speak first" situation: no new message, do not answer a question nobody asked. But the customer's message was still unanswered, so the model was told to ignore the one thing it had to answer. On a wake where the host's history still ends with a customer message, the speak call is now told that message has no answer yet.

- **`validateFlow` and `fromSpec` check the JSON's shape before its names.** A stored row or a generated spec with a string where a list belongs crashed with a raw `TypeError` that named no flow (`steps: [null]`, `on: {}`, `then: 5`), or passed and misbehaved: `collect: "nome"` asked for the fields "n", "o", "m", "e", `message: "quer agendar"` reached the model one letter per phrase, `onEnd: "restart"` just ended the run. Each is now a `FlowConfigurationError` that names the flow, the step and the key, with the fix. A step that does two things (`say` and `do`) ran only the first and dropped the other without a word; it is now rejected, and so is a spec step whose `kind` disagrees with its body. A `when` branch on a wait step, which no call ever judges, is rejected too, and `flowSpecSchema` no longer offers one.

- **The agent build catches three more mistakes that used to fail on live turns.** An unknown condition in an agent or idle instruction's `if` made every `turn()` throw; a host condition named `equals`, `known` or `silenced` was never called, because the built-in answered first; a literal `then: { flow: "humnao" }` naming no flow was only skipped at run time with `flow-gone`. All three now throw `FlowConfigurationError` when the agent is built. `Registries` takes an optional `flows` list for the last check; a templated `{ flow }` is still resolved per run.

- **An action that defers by something that is not a duration fails its step instead of throwing the turn.** `{ defer: "2 minutos" }` threw outside the guard around the handler, so the turn failed after the side effect had happened, and every replay did it again. The step now fails with `code: 'action-failed'` and a `detail` that quotes the value, and `onFail` applies.

- **`if.equals` words its two mistakes like an action parameter does.** A value off a field's enum read "gives a string, but the field is a string", and an integer field read "a integer". It now reads `if.equals gives "etapa" "frio", which is not one of "novo", "quente". Use one of the listed values.` and `…but the field is an integer. Write an integer; values are not coerced.`

- **A session that vanished between load and save says so.** `SessionConflictError` read "modified concurrently … found none" when the row had been deleted or had expired (a Redis TTL), which sent the reader looking for a race. That case now reads `Session "s1" is gone from the store: it was at version 3 and has since been deleted or expired. Load it again; a load that finds nothing starts a new conversation.` The class and `actualVersion: undefined` are unchanged.

- **Constructor errors follow the house format.** The providers, `FallbackAiProvider`, `CompactionEngine` and `fakeClock` threw bare sentences ("Gemini API key is required", "compactionThreshold must be between 0.5 and 0.95, got 1.2"); each now names the class, the option, why it matters and what to pass, e.g. `[GeminiProvider] model is empty: there is no default. Pass one, e.g. { model: "gemini-2.5-flash" }.` The Gemini example no longer names a preview model. `compaction.maxTokens` of 0 or less is now rejected at construction instead of compacting every turn.

- **A flow id with a `:` gets its silence wake.** The wake key is `silence:<flowId>:<sessionId>:<ms>`, and the flow id was read up to the first `:`, so `follow:up` was looked up as `follow` and every wake was skipped as `flow-gone`. The key is now cut at the session id.

### Unchanged

- The provider classes (`GeminiProvider`, `OpenAIProvider`, `AnthropicProvider`, `OpenRouterProvider`, `DeepSeekProvider`, `ZaiProvider`, `FallbackAiProvider`, `OpenAICompatibleProvider`, `ProviderAdapter`), the `AiProvider` seam, the `compaction` option and the history helpers. Their options are unchanged; what they send is not — see Fixed, and `GenerateMessageInput` gained an optional `system`.

## [3.4.1]

### Dependencies

- **Bump `@providerkit/core` to `^0.10.0`**:
  - Centralized `isRetryable` predicate honoring `x-should-retry` headers, transport network blips, and rate-limit bounds.
  - Wire-level tool schema sanitization: `toGeminiToolSchema` converts nullable union types (`anyOf` with null, array types with null) into OpenAPI 3.0 `nullable: true`, normalizes numeric enums to strings, and strips unsupported keywords; `toAnthropicToolSchema` unwraps root union schemas into unified object schemas.
  - Wire tool-argument repair: rescues concatenated/prepended JSON objects via `findLastValidJsonObject`, normalizes blank tool call IDs, and bounds tool call IDs to <= 64 characters for ChatGPT Responses compatibility.
  - OpenRouter sticky routing: auto-pins requests to the model's first-party vendor host (`openRouterHostFor`) to preserve KV prompt caching across multi-turn agent conversations.
  - Gemini 3.x and 2.x dual thinking support: uses `thinkingLevel` (`MINIMAL`, `LOW`, `MEDIUM`, `HIGH`) for Gemini 3+ models and `thinkingBudget` for Gemini 2.x.
  - Context overflow token margin extraction via `parseContextOverflow`.
  - Added `subtractUsage` and `UsageTracker.subtract` for rolling back optimistic turns without negative ledger drift.

## [3.4.0]

### Added

- **FallbackSpec preset-id fallback resolution**: providers can now declare cross-provider fallbacks by preset ID with full dialect, endpoint, and credential encapsulation.
- **Dynamic model capabilities resolution**: on-demand model capabilities resolution via `resolveModelCapabilities` with ID normalization and caching.

## [3.3.0]

### Added

- **Shared cooldown-aware fallback pool**: cross-provider fallback handling with transient error tracking and cooldown management.

## [3.2.5]

### Fixed

- **A field the model extracts but the schema never declared no longer kills the turn.** Pre-extraction asks for the schema's fields, but a model can return more — `battery_health`, `product_interest` — and `updateCollectedData` treated any undeclared key as a validation error. The `DataValidationError` escaped the routing phase as a `ResponseGenerationError`, so the whole turn failed and the user got the consumer's error fallback instead of a reply, over one key nobody asked for. `validateData` now reports an undeclared key as a warning, and `updateCollectedData` drops it with one log line naming it. Pre-extraction drops it too, before returning: all three pipeline merge points write the extracted data into the turn session before `updateCollectedData` sees it, so filtering only there would still have persisted the key. Declared fields are handled exactly as before.

## [3.2.4]

### Fixed

- **The response prompt now shows the model what is already collected.** Pre-extraction runs before a step is chosen and merges what the user's message said into `session.data`, but only the routing prompt ever rendered that data; the response prompt listed the step's fields with no values, so a step whose guideline says "ask which device" asked for a device the user had just named — the extraction call was paid for and its result never reached the model that writes the reply. Each field already present in session data is now marked `← ALREADY KNOWN: "value"` in the Data Collection Rules, with the rule that a known field is never asked for again even when the guideline says to ask, and when every FOCUS field of the current step is known the prompt says the step's questions are done. No skip is implied: a step that greets and collects still runs, it just stops re-asking.

## [3.1.1]

### Fixed

- **On OpenRouter, `effort: 'none'` now really means none, and `'max'` reaches the gateway's top tier.** The 3.1.0 note below says OpenRouter floors `none` at `low`; that was true of the `@providerkit/core` it shipped against and is retracted here. The floor was built on reading one field's 400 onto another — that gateway does refuse `reasoning: { enabled: false }` on a model that always thinks, but `reasoning: { effort: 'none' }` is a value its own enum takes, and an effort a model cannot honour is mapped to the nearest rather than refused. So a turn that asked not to think was budgeting for a `low` pass it never ordered, which is the whole failure `config.effort` was added to prevent: a capped `maxTokens` spent on invisible reasoning. That same enum runs `xhigh > high > medium > low > minimal > none`, so `max` no longer clamps to `high` there either — 0.95 of the thinking budget instead of 0.8.
- **A structured-output request now describes the shape it wants on the gateways.** Every provider on the OpenAI dialect that is not OpenAI itself — OpenRouter, DeepSeek, GLM, Kimi, Groq — went out as `response_format: { type: 'json_object' }` and nothing more, which asks for valid JSON and says nothing at all about which JSON. A step with a `jsonSchema` got back syntactically perfect JSON in a shape nobody asked for: the parse succeeded and the step received an object with none of the fields it declared, on the happy path, where no retry looks and no error is recorded. The schema now rides as a system message wherever the endpoint cannot enforce it natively.

Both arrive with the dependency floor, raised to `@providerkit/core@^0.4.3`. Nothing in this package's own API moved.

## [3.1.0]

### Added

- **`config.effort` — a provider can once again be told not to think.** Every `@providerkit/core` factory takes a bound `effort`, and none of the six provider classes forwarded it, so v3 had no way to reach the one setting that turns thinking off: an absent effort means the model's own dynamic thinking on every shape. That is fine until `maxTokens` is small, because thinking tokens come out of the same budget as the answer — a capped turn could spend the whole allowance thinking and return a completion with no text in it, which the framework correctly reports as a failed turn. `config: { effort: 'none' }` now rides to the wire on all four shapes (`thinkingLevel: MINIMAL` on Gemini, `thinking: { type: 'disabled' }` on DeepSeek, `reasoning_effort: 'none'` on OpenAI, `reasoning: { effort: 'none' }` on Responses, and no `thinking` block at all on Anthropic, where extended thinking is opt-in so the default already is off). This is what v2's `thinkingConfig: { thinkingBudget: 0 }` migrates to. Requires `@providerkit/core@^0.4.1`: on the two OpenAI shapes, 0.4.0 emitted the field only for graded levels, so `none` produced the same request as never asking — which is the model's own default, and that is `medium` on everything older than GPT-5.1. `max` is this package's word and not every vendor's — on the Responses shape it clamps to `high`, the top of OpenAI's enum, which sending it verbatim 400'd on. One exception by design: OpenRouter floors `none` at `low`, because models that always think refuse to have it disabled — zero is not reachable there, so a deployment routing through that gateway budgets for one `low` thinking pass.

## [3.0.0]

### Changed (BREAKING)

- **The provider layer is now `@providerkit/core`.** The six provider classes keep their names, their constructor options and their place in the public API, but everything underneath them — message building, streaming, tool-call assembly, retry, backup models, error classification — moved into a package built for exactly that job, and the three vendor SDKs went with it. `@anthropic-ai/sdk`, `@google/genai` and `openai` are no longer dependencies of this package: installing `@falai/agent` no longer installs one vendor's SDK for a consumer who uses another. The provider layer went from 3,521 lines to 915.

  The reason this is a major and not an internal change: the seams that used to leak a vendor's types are gone.
  - `config` was `Partial<ChatCompletionCreateParamsNonStreaming>` (and Anthropic's / Gemini's equivalents). It is now `RequestConfig` — `temperature`, `topP`, `maxTokens`, `stopSequences` — the fields every supported shape actually has. A vendor-specific knob belongs to that vendor's own client. **Migration:** rename `top_p` → `topP`, `max_tokens` → `maxTokens`, `stop` → `stopSequences`; a field outside that set was silently ignored on at least one provider already.
  - `client` (an injected SDK instance, for tests) is now `fetchImpl`. There is no SDK to inject; a test scripts the bytes the provider really receives.
  - `ProviderError` and its kinds come from `@providerkit/core`. The kind lives on `error.kind`, not `error.code`, and the taxonomy is wider — thirteen kinds named by what fixes them, where this package had eight. A caller can now tell an exhausted balance from a per-minute throttle, a plan that never included the API from a wrong key, and an outgrown context window from a generic bad request. `rate_limited` is `rate`, `overloaded` is `overload`, and `invalid_request` splits into `invalid`, `context`, `model` and `content`. `schema_rejected` is gone: nothing ever produced it.
  - `ReasoningConfig` takes the shared effort union — `"none" | "low" | "medium" | "high" | "max"`. **Migration:** `"minimal"` is spelled `"low"`. `summary` and `includeThoughts` are gone; they are no longer choices, because the shapes that need them get them switched on whenever an effort is set, which was the only setting that ever produced reasoning output.

- **`retryConfig.timeout` now bounds SILENCE, not the whole call.** It was a total wall-clock cap on a non-streaming attempt, so a healthy but long generation died at the one-minute mark. It is now the gap allowed before the first byte and between any two after it. A request that never gets a reply still fails at the same moment; one that is steadily producing tokens is left alone. Same field, same default (60s).

- **Node 22.12+.** Node 18 reached end of life in April 2025 and Node 20 in April 2026, so the floor is now declared in `engines` rather than implied. It is 22.12 and not 22 because the CJS build `require()`s `@providerkit/core`, which is ESM-only — `require(esm)` is what makes that work, and it landed in 22.12.

### Added

- **Prompt-cache accounting.** A turn's metadata now carries `cachedInputTokens`, the cache-hit subset of the prompt — billed far cheaper, and previously not read at all. Anthropic's cache reads and writes are reconciled into the same numbers the OpenAI shapes report, so one usage record means the same thing across providers.
- **Structured output is enforced on the streaming path too.** Only the non-streaming path could reach a schema-enforcing endpoint before, so streaming silently degraded to plain JSON mode. Both paths now run the same pipeline: `generateMessage` is `generateMessageStream` drained.
- **`ProviderAdapter` is exported.** Subclass it to bind any `@providerkit/core` provider to this framework's seam.

### Fixed

- **`import` from this package now works under plain Node.** The ESM build re-exported its own modules without file extensions (`export { Agent } from "./core/Agent"`), which Node's ESM resolver refuses to guess — so `import { createAgent } from "@falai/agent"` threw `ERR_MODULE_NOT_FOUND` on the first specifier it hit. This was true of every 2.x release too, not just this one: bundlers resolve an extensionless specifier and the CJS entry guesses the extension, so the only consumers who ever hit it were the ones running the ESM build directly, and nothing here caught it — the tests run off source, under bun, which guesses as well. All 392 relative specifiers are explicit now, `tsconfig.json` is on `node16` resolution so tsc rejects an omission rather than emitting it, and `bun run build` ends by loading both built entries under real Node.

- **A branch that parks on a step of its own flow no longer kills the turn.** The router calls "flow complete" from the linear chain alone — this step has no successor, so it is an implicit terminus — and it decides that *before* branches run. `determineNextStep` was meant to let branches override that verdict, but it only did so when the branch changed FLOW. A branch resolving to a step of the current flow (`then: '<stepId>'`, `then: { goToStep: '<stepId>' }`, `then: { reset: true }`) therefore resolved a step the caller immediately discarded: no LLM call, an empty reply, and the flow marked completed — excluded from routing for the rest of the session, so every following message fell through to the fallback path. The verdict now belongs to `determineNextStep`, which clears it whenever a branch resolved a position at all. Parking a flow on its last step — the natural way to hold a conversation open after its goal is met — works as the docs describe it.

- **Anthropic structured output was never actually requested.** Anthropic has no native schema mode, and the schema was reaching the request as nothing at all — so the model answered in prose, the parse failed, and the turn returned no structured output while looking like a success. The schema now rides as a system block, placed after the cached one so a per-call schema cannot invalidate the system prompt's cache.
- **A schema with optional fields no longer 400s on OpenAI.** Strict mode demands every listed property be required and every object closed, all the way down; a flow with a `data` block or a collecting step produces neither. Enforcement is now requested only when the schema can satisfy it.
- **`jsonSchema: {}` no longer asks for JSON mode.** Compaction's summariser passes an empty schema meaning "no schema"; sent as one it became a schema block with no type, which is a flat 400 — so conversation summarisation silently failed on the shapes that enforce schemas.
- **Gemini now sends a response schema alongside tools.** It was dropped when both were present, from a 2024-era API constraint that no longer holds.
- **A model the gateway will not serve walks to the backup model** instead of ending the turn.

## [2.6.1]

### Added

- **`AgentOptions.maxToolLoops` is now configurable.** The tool-loop cap was hardcoded to 5 inside `ToolLoopExecutor`; it is now exposed on `AgentOptions` and wired through `Agent` → `ResponseModal` → `ToolLoopExecutor`, so `createAgent({ maxToolLoops: N })` bounds how many follow-up tool rounds a single turn may run (the initial tool batch executes once before the loop, as before). Applies to both `respond()` and the streaming path, and an explicit `0` is honored. Default remains 5.

## [2.6.0]

### Changed (BREAKING)

- **Streaming now emits clean message text, not the raw structured-JSON wrapper.** Under a JSON schema (every flow turn), providers stream the wrapper `{"message":"…"}` token by token; `respondStream()`/`stream()` previously forwarded those raw fragments as `delta`/`accumulated`, so every consumer had to re-implement partial-JSON unwrapping — and `stream()` even persisted the raw JSON as the assistant message, while `generate()`/`chat()` stored the clean text. The framework now extracts the top-level `message` field incrementally (a new internal `StreamingMessageDecoder` that tracks object depth and string/escape context, so a nested or decoy `"message"` is never mistaken for it and a half-decoded escape is never emitted): `delta` carries the message's token-delta, `accumulated` is the clean message-so-far, and the parsed object is still surfaced on the final chunk via `structured`. Plain-text (non-JSON) streams pass through unchanged. **Migration:** remove any app-side unwrapping (`unwrapLlmContent`/`parseMessageContent`-style) of streamed `delta`/`accumulated` — they now receive clean text and would double-process; read collected fields from the done chunk's `structured` as before.

### Fixed

- **Streaming data collection now matches the non-streaming path.** Two divergences are fixed: (1) collection was gated on the step declaring `collect`, so a flow's `requiredFields`/`optionalFields` were never harvested on the streaming path — it now collects for any flow step, like `generate()`; (2) a tool-driven streamed turn collected from the model's *first-pass* output instead of its *post-tool follow-up*, dropping fields the model produced only after seeing tool results — it now prefers the follow-up structured, matching `generate()`.
- **The post-signal phase now runs on non-streaming auto-chain completion.** When an auto-step chain completed a flow (`last_step`/`completed`/`goto`), the non-streaming path returned early and skipped the post-signal phase — so `post`/`both` signals never fired and a post-phase `pendingDirective` was never wired (the streaming path already ran it). Both paths now run it. Auto-chain *halt* (a deliberate verbatim short-circuit) still skips the post-phase in both paths, but the non-streaming path now surfaces any pre-phase `triggeredSignals` too.

### Internal

- **The streaming and non-streaming response paths now share one decision spine.** `generateUnifiedResponse` and `generateUnifiedStreamingResponse` were parallel implementations ("unified" in name only) whose drift caused the 2.4.x retry/empty bugs and the divergences above. Signal-halt detection, the auto-chain walk, flow/step selection, and the post-signal phase are now a single `planTurn` + `applyTurnPostPhase`, used by both; each path only *renders* the shared `TurnOutcome` in its own idiom (await a value vs. yield chunks) and keeps its own leaf primitive (sequential `generateMessage` + `runLoop` vs. concurrent stream + `runStreamingBatch`). The two genuinely-different behaviors a full "drain the stream" collapse would have regressed — non-streaming's sequential tool execution and OpenAI's native `responses.parse` structured output — are deliberately kept distinct.

## [2.5.0]

### Added

- **Streaming now has a first-chunk (time-to-first-token) timeout.** `respondStream()`/`stream()` previously had no bound on how long a provider could take to produce its first token — a provider that opened a stream and then stalled would hang the turn indefinitely, with no equivalent of the non-streaming per-attempt timeout. The shared streaming retry helper (`withStreamRetry`) now races the first chunk against a deadline (`firstChunkTimeoutMs`, wired to each provider's existing `retryConfig.timeout`, default 60s): a stall is treated as a failed attempt and retried on the same model, then falls through to backup models — exactly like an empty completion. Only the *first* chunk is bounded, so a long but healthy stream is never cut off, and the deadline reuses the existing config (no new public option). If every attempt is exhausted it surfaces as a `"Stream timed out"` error (classified as `timeout`).
- **An abandoned attempt now actually cancels its upstream provider call, instead of leaving it running while a retry stacks a second.** Abandoning an attempt — a first-chunk timeout, a pre-yield error before a retry, or a consumer that breaks mid-stream — only dropped the JS generator; the underlying SDK request kept running, because the abort never reached it (a generator stalled inside `await sdkStream.next()` won't even honor `return()` until that call settles). Against a flaky provider, retries could stack concurrent calls. Both retry helpers now thread an `AbortSignal` into the work they run — `withStreamRetry` aborts a fresh per-attempt signal on abandon; `withTimeoutAndRetry` hands the operation its existing timeout signal — and every provider combines that signal with the caller's `input.signal` (via a new `combineAbortSignals` helper) and passes it to the SDK on **both** the streaming and non-streaming paths. Anthropic and the OpenAI-compatible providers previously passed no signal to their SDK at all (so even caller-initiated cancellation never reached the wire); Gemini passed only the caller's. `combineAbortSignals` prefers the platform `AbortSignal.any` (which cleans up its listeners via weak refs) and falls back to a manual controller on runtimes without it (< Node 20.3), so the library keeps working on older runtimes.
- **`createOpenAICompatibleProvider({ name, baseURL, apiKey, model, … })`** — build a provider for any OpenAI-compatible endpoint (Azure OpenAI, Groq, Together, Fireworks, vLLM, LM Studio, Ollama, a self-hosted gateway…) from config alone, no subclass. Structured output defaults to chat-completions `json_schema` (the broadest-compatible enforced mode), selectable via `structuredOutput: "json_schema" | "json_object" | "responses_parse"`; `defaultHeaders` covers per-endpoint auth (e.g. Azure's `api-key`), and `capabilities` overrides merge over sensible defaults. It shares the same `OpenAICompatibleProvider` base as the dedicated `OpenAIProvider`/`OpenRouterProvider`/`DeepSeekProvider` classes — this is the no-subclass path for everything else.
- **Streaming tool turns now loop across multiple rounds, matching the non-streaming path.** Previously `respondStream()`/`stream()` ran one concurrent batch of tool calls and then forced a closing message — a streamed turn could not *chain* tools (call a tool, see its result, decide to call another). The streaming and non-streaming tool engines now share one multi-round follow-up loop (`runFollowUpLoop`): the streaming path keeps its concurrent initial batch and tool-progress chunks, then re-prompts with the results so the model can request further tools, up to `maxToolLoops` (default 5) — exactly like the non-streaming `runLoop`. Single-round turns are unaffected.

### Internal

- **Structured-output strategy lifted into the OpenAI-compatible base as config.** The choice between `responses.parse` and chat-completions `json_schema`/`json_object` is now a single `structuredOutput` field on `OpenAICompatibleProvider` instead of per-subclass `executeStructuredGenerate`/`structuredResponseFormat` overrides. `DeepSeekProvider` and the new generic provider set the field and drop the overrides, so "how this endpoint does structured output" has one definition; `OpenAIProvider`/`OpenRouterProvider` keep the default `responses.parse`.

- **Provider retry/response plumbing consolidated** (no public API change). The `||`/`??` retry-config defaulting (the `retries: 0` honoring fix from 2.4.3) now lives in a single shared `resolveRetryConfig`, removing the byte-identical block and three local `DEFAULT_RETRY_CONFIG` copies from the providers; the capped-exponential backoff is a single `defaultBackoff`; the empty-completion "blank message" check is one shared `effectiveMessageText` used by both the streaming and non-streaming guards; and `forceFinalTextFromTools` reuses the existing `assistantMessage`/`toolMessage` history factories. Net ~60 fewer lines across the three providers. One behavior refinement falls out of unifying the guard: a whitespace-only completion with no tool calls is now treated as empty (throw + retry) on the non-streaming path too, matching the streaming path (previously such a response was passed through).

### Fixed

- **Gemini reasoning ("thought") parts can no longer leak into the message.** `safeExtractText` concatenated every part with `text != null`, but with `includeThoughts` enabled a reasoning part also carries `text` (alongside `thought: true`) — so the model's chain-of-thought would be prepended to the user-facing message. It now excludes parts flagged `thought`, keeping only the answer text.
- **Removed an unreachable branch in single-flow step selection.** `FlowRouter.decideSingleFlowStep` had a second `if (candidates.length === 0)` guard after the `length === 1` block, which the earlier `length === 0` early-return already made dead. No behavior change.

## [2.4.3]

### Security

- **Tool authorization/validation gates are now enforced on the streaming path.** `validateInput` and `checkPermissions` (documented as "when denied, handler is NOT invoked") were applied only in `ToolManager.executeTool`, which backs `generate()`/`respond()`. The streaming executor (`StreamingToolExecutor`, used by `stream()`) invoked tool handlers directly, so a tool gated for access control ran with unvalidated/unauthorized arguments on the streaming transport while the same call was correctly blocked on the non-streaming one. Both paths now run the gates through a single shared module (`toolGates`), so a denied tool's handler is never invoked regardless of transport. If you relied on this bypass, a previously-running `stream()` tool call may now be denied — the same as it already was under `generate()`.
- **Session/user ids are validated as scalars before reaching a persistence query.** Methods that look up by id (`getSession`, `loadSessionState`, `getSessionMessages`, `deleteSession`, `findActiveSession`, `getUserSessions`, `getUserMessages`) and `SessionManager.getOrCreate` forwarded their argument straight into the adapter. With a NoSQL adapter (e.g. MongoDB), a non-string value such as `{ $ne: null }` — trivially produced by an unvalidated HTTP body or an Express `?sessionId[$ne]=` query — is interpreted as query operators, enabling cross-tenant session/message reads and `deleteMany`-based mass deletion. These ids are now rejected at the framework boundary (extending the guard that already existed on the save path) with a clear `"... must be a non-empty string"` error; `undefined` still auto-generates and empty strings keep their fall-back semantics.

### Fixed

- **Empty streaming completions now retry like the non-streaming path instead of emitting a blank message.** When a provider returned no text and no tool calls, `respondStream()`/`stream()` silently yielded an empty final chunk, while `respond()`/`generate()` threw `"No response from <provider>"` inside `withTimeoutAndRetry` and recovered on the same model. The streaming model call (`generateStreamWithModel` in the Gemini, Anthropic, and OpenAI-compatible providers) now applies the same empty-completion guard and is wrapped in a new `withStreamRetry` helper — the streaming analog of `withTimeoutAndRetry` that re-runs the stream only while it fails *before yielding its first chunk* (an empty completion yields nothing, so a retry can never double-emit deltas already sent to the consumer). A valid-JSON-but-blank structured message (`{"message":""}`) is now treated as empty on **both** paths. If every attempt still comes back empty, the error surfaces (on `respondStream` via the done-chunk `error` field) instead of reaching the user as a blank message.
- **The streaming path now produces a result-aware message after tools run but the model returns no text.** Non-streaming `runLoop` already made a follow-up LLM call to turn tool results into a user-facing message; the streaming concurrent batch (`runStreamingBatch`) skipped this and could surface the bare tool-invocation preamble — or nothing — as the response. Both paths now share the same forced-final-text logic (`forceFinalTextFromTools`), so a streamed turn that executes tools ends with a message generated from their results.
- **An explicit `retryConfig.retries: 0` is now honored instead of being silently coerced to the default.** All three providers built their retry config with `retries || DEFAULT_RETRY_CONFIG.retries`, so passing `0` to disable retries fell through to the default of `3`. This is now `?? `, which respects an intentional zero; the same falsy-zero coercion is fixed for `maxToolLoops`. (`timeout` keeps `||` deliberately — a 0ms timeout aborts every call immediately, so falling back to the default is the safe behavior.)
- **A persisted session's owner (`userId`) is no longer derived from collected-data metadata.** On first save, a new session row took its `userId` from `collectedData.metadata.userId` (model/user-influenced state) when present, `JSON.stringify`-wrapped — a latent tenant mis-attribution footgun, and a correctness bug (the wrapped value never matched `findByUserId`/`findActiveByUserId`, orphaning the session). The owner is now always the authenticated principal from `PersistenceConfig.userId`, matching `createSession`.

## [2.4.2]

### Fixed

- **Extraction-mode signals gated only by `if` (no `when`) now run their extraction.** A signal with `extract` plus an `if` predicate but no `when` — the shape of the documented `leadStage` example — matched through the code path but never issued an extraction call, so its handler always received `ctx.extracted: undefined`. Extraction now runs for every code-matched signal (unconditional or `if`-gated) that declares `extract`, alongside the existing `when`-conditioned path. LLM-conditioned signals are unaffected: their extraction is still merged into the single classifier batch.
- **A matched extraction-mode signal that returns no payload is no longer silent.** When the classifier reports `matched: true` but returns no `extracted` value — commonly because the `extract` schema used a provider-ignored keyword such as `nullable: true` instead of `type: ['string', 'null']`, so the model omits the field — the firing now carries an `extractionError` and a WARN is logged, instead of passing `extracted: undefined` to the handler with no trace. The handler still runs.

### Added

- **`SignalFiring.extractionError`** — set when an extraction-mode signal matched but no `extracted` payload was returned (see above). Optional and additive.

## [2.4.1]

### Fixed

- **Sessions now finalize exactly once per turn.** Non-streaming halt paths (signal halt, auto-chain halt/complete) previously finalized twice — running the step `finalize` hook and the persistence auto-save a second time. Streaming previously persisted the session *before* the post-signal phase, so a post-signal `pendingDirective` was never persisted for `respondStream()`-only callers, and the branch flow-transition chunk never finalized at all. Both paths now run post-signal phase → finalize, once.

### Internal

- **Response layer decomposition** (no behavior change; the public API surface is untouched). `ResponseModal` (~2,900 lines owning roughly eleven concerns) is now a thin coordinator over focused collaborators:
  - `ResponsePipeline` is the single owner of routing, step selection, and branch evaluation — `routeAndSelectStep()` is the turn's routing entry point (routing-skip optimization, pre-signal phase in parallel with routing, pre-extraction, next-step determination) and `resolveRenderStep()` replaces the render-step logic previously duplicated in the streaming and non-streaming paths. ~600 lines of dead duplicated tool/data-collection logic were removed from it.
  - `ToolLoopExecutor` owns the tool follow-up loop (run tools → ask the LLM again → reconstruct tool-result history → force a final text response) and the streaming concurrent batch via `ToolManager.executeWithConcurrency`, which falls back to the same loop. `ToolManager` remains the registry/resolver and single-tool executor.
  - `SessionFinalizer` is the single implementation of end-of-turn finalization: deterministic compaction, persistence auto-save, the step `finalize` hook, and live-session sync.
  - `SignalCoordinator` owns signal pre/post phase orchestration, including position-directive application and the post-phase result application previously duplicated at four sites.
  - `StepLifecycle` executes step `prepare`/`finalize` handlers (function, tool id, or inline tool).
  - `ResponseGenerationError` moved to `src/core/ResponseGenerationError.ts`.
  - `ResponseModal` consumes a narrow `ResponseModalDeps` interface (implemented by `Agent`), so the response layer is testable without constructing a full `Agent`.

## [2.4.0]

Architecture hardening release: concurrency safety for sessions, a consolidated provider layer, and a stricter type surface. See `docs/migration/v2-3-to-v2-4.md` for the upgrade guide.

### Added

- **Optimistic session locking.** `SessionState`/`SessionData` carry a `version` incremented on every save. A save with a stale version throws the new `SessionConflictError` (exported) instead of silently overwriting state written by a concurrent turn — the failure mode for parallel webhooks or double-sends. Rows written by pre-2.4 versions have no stored version and are accepted without conflict. SQLite and PostgreSQL adapters auto-add the `version` column on `initialize()`; Prisma users should add `version Int?` to their session model (the adapter detects a missing column and degrades gracefully, leaving locking inactive). Same-process concurrent saves of one session are serialized through a per-session queue and never conflict with each other.
- **Session schema versioning.** `PersistenceConfig.schemaVersion` stamps persisted state; `PersistenceConfig.migrateSession(collectedData, fromVersion)` upgrades state written by older deployments at load time. Without a migrator, a version mismatch logs a warning and loads as-is.
- **Failed-turn rollback.** If `respond()`/`stream()` throws mid-turn, the in-memory session is restored to its pre-turn snapshot, so in-memory and persisted state stay consistent (a failed turn has no effect; the user message added before the turn is retained).
- **Deterministic history compaction.** When `compaction` is configured, it now runs at end-of-turn finalize on every `respond()`/`chat()`/`stream()` — previously it only ran inside `session.addMessage()`, so respond-only integrations grew history unboundedly.
- **`ProviderError` with normalized codes.** Terminal provider failures (after retries and backup models) now throw `ProviderError` with a `code` of `rate_limited | overloaded | auth | invalid_request | schema_rejected | timeout | network | unknown` and the original SDK error as `cause`.
- **`AiProvider.capabilities`.** Every provider declares `ProviderCapabilities` (`supportsTools`, `supportsNativeJsonSchema`, `supportsStreaming`, `supportsStreamingToolCalls`, `supportsPromptCaching`). Notably, Anthropic reports `supportsNativeJsonSchema: false` — its structured output is prompt-instructed, not schema-enforced.
- **`OpenAICompatibleProvider` base class** (exported). OpenAI, DeepSeek, and OpenRouter are now thin subclasses (~80–150 lines each, down from ~650); building a new OpenAI-compatible provider (Groq, Together, …) is a small subclass instead of a 600-line copy.
- **New exports:** `SessionConflictError`, `ProviderError`, `ProviderErrorCode`, `ProviderCapabilities`, `SessionUpdateOptions`, `OpenAICompatibleProvider`, `ResolvedSignalDirective`.

### Changed

- **`session.data` is the single source of truth for collected data.** The bidirectional sync between `Agent`'s internal copy and the session (a divergence footgun under load) is gone. `getCollectedData()`/`getData()` read from the live session; `updateCollectedData()` writes into it. Data set before any session exists (including `initialData`) is staged and seeds the first created session; loading an existing session keeps the stored data. `agent.currentSession` now delegates to `agent.session` instead of holding a second copy.
- **Passing an explicit `session` to `respond()` no longer merges the managed session's data into it** — that was cross-session state leakage.
- **`ResponsePipeline` no longer holds mutable turn state.** Context and session are passed explicitly; `determineNextStep` takes a required `context` parameter.

### Breaking

- **Custom `AiProvider` implementations must declare `capabilities`.**
- **Custom `SessionRepository` implementations:** `update()` gained an optional `options?: { expectedVersion?: number }` parameter. Implement the compare-and-swap (see `MemoryAdapter`) or ignore it to opt out of locking.
- **Generic defaults are now `unknown` instead of `any`** on `Agent`, `Tool`, `ToolContext`, `ToolResult`, `ToolHandler`. Untyped tool code that relied on implicit `any` may need explicit type parameters or type guards. `ToolHistoryItem.content` is now `unknown`.
- **`SignalFiring.directive` is typed `ResolvedSignalDirective`** — `replyWith` is resolved onto `reply` before firings reach the response surface (this was already the runtime behavior).
- **Removed from the public barrel:** `DirectiveChainTracker`, `DirectiveChainEntry`, `StreamingToolExecutor` (internals that locked the architecture into semver).
- **Removed:** `ResponsePipeline.setContext/setCurrentSession/getStoredContext/getCurrentSession` and `ResponsePipeline.updateDataFlow` (stored-state API replaced by explicit parameters).
- **Provider terminal errors are now `ProviderError`** — code that matched on raw SDK error shapes after retry exhaustion should match on `error.code`, with the original error available on `error.cause`.

### Internal

- `ToolManager` no longer value-imports `Agent` (runtime circular dependency broken).
- Shared `evaluateIfPredicates` utility — branch, signal, and auto-chain `if` evaluation now use one implementation; `AutoChainExecutor` uses the canonical `BranchEntry`/`BranchMap` types instead of a divergent local copy.
- The `beforeRespond` hook's context result is returned explicitly from `prepareResponseContext` instead of being read back from pipeline state; the agent context is no longer redundantly self-updated every turn.
- New test suite `tests/session-concurrency.test.ts` covering locking conflicts, save serialization, version round-trip, schema migration, failed-turn rollback, and pre-session data staging.

## [2.3.0]

### Added

- **`!` exclusions are now supported across all AI-evaluated `when` fields.** Flows, steps, branches, instructions, and signals now share one `ConditionWhen` syntax: non-`!` entries are OR alternatives, while `!`-prefixed entries are stripped and treated as OR exclusions where any match inhibits the condition. Negative-only `when` values mean "active unless this exclusion matches."

## [2.2.4]

### Fixed

- **Signal `when` arrays now use OR semantics for positive entries.** Non-`!` entries are treated as alternative natural-language matches, consistent with flows, steps, instructions, and branches. `!` exclusions still inhibit when any exclusion matches.
- **Post-phase signal `reply` / `replyWith` now replaces the final message.** Non-streaming responses return the post-signal replacement, and streaming responses expose it on the terminal chunk's authoritative `accumulated` value.
- **Failed signal handlers no longer burn `once` or cooldown state.** `SignalsState.triggers` is recorded only after the handler completes successfully; handler failures still appear on `SignalFiring.handlerError`.

## [2.2.3]

### Added

- **`createPersistedState` re-exported from package root** — The session persistence helper was previously only available via `@falai/agent/utils`. Now exported from the main entry point for convenience.

## [2.2.2]

### Added

- **`DeepSeekProvider`** — New provider for the DeepSeek API (OpenAI-compatible). Supports `deepseek-chat` and `deepseek-reasoner` models with backup model failover, retry logic, streaming, and reasoning content extraction. Uses the `openai` SDK with a custom base URL — no new dependencies required.

## [2.2.1]

### Fixed

- **Conditional instruction `when` clauses now reach the response model.** `PromptComposer.addInstructions()` previously collected textual `when` clauses but rendered only the instruction prompt, so the model could not apply the condition. Conditional instructions now render their `when` clauses inline after deterministic `if` predicates pass.
- **`when: string[]` now consistently means OR across flows, steps, instructions, and branches.** Arrays represent alternative natural-language matches, such as `"client asked about the address"` or `"client asked where we are located"`. Code-evaluated `if: predicate[]` retains AND semantics. Signal conditions keep their documented specialized include/exclude behavior.

### Internal

- Migrated package scripts from npm invocations to Bun (`bun run`, `bun pm version`, and `bun publish`) and removed an empty `preinstall` hook.

## [2.2.0]

### Changed

- **`@google/genai` upgraded** from `^0.3.0` to `^2.7.0`. The `GeminiProvider` already targeted the modern unified SDK surface (`new GoogleGenAI()`, `models.generateContent`, `Type` enum), so no provider code changes were required. Typecheck, lint, and the full test suite pass against the new SDK.

### Removed

These were all dead or `@deprecated` symbols carrying no runtime behavior. If you imported any of them, the fix is a straight deletion or the noted replacement.

- **`CompositionMode` enum** — had a single member (`FLUID`) and was referenced nowhere. Already documented as removed in the v1→v2 migration guide; the dead export is now actually gone.
- **`RoutingDecision` / `RoutingSchemaOptions` types** — listed as removed in the v1→v2 migration guide but still present as zombie exports. Now removed. The live routing type is `FlowRoutingDecisionOutput` (internal).
- **`normalizeHistory` utility** — `@deprecated` alias for `historyToEvents`. Use `historyToEvents` instead.
- **`renderTemplate` / `renderTemplateObject`** — `@deprecated` synchronous helpers, removed from the public surface. Use the async `render` function instead. (Both remain internal implementation details of `render`.)
- **`NamedSchema` type** — unused, never exported on the stable surface.
- **`MessageRoleType` / `EventKindType` type aliases** — unused aliases of the `MessageRole` / `EventKind` enums. Use the enums directly.
- **`Flow.getTerms()`** — `@deprecated`, always returned `[]` (flow-level terms were removed in v2). Terms are agent-level via `agent.getTerms()`.
- **`ToolManager.execute()` / `ToolManager.executeTools()`** — an unused fallback-tools + retry subsystem with no callers. The live execution paths are `ToolManager.executeTool()` (single) and `ToolManager.executeWithConcurrency()` (batched). Tool error handling, validation gates, and permission gates are unchanged — they live in `executeTool()`.

### Fixed

- **`SqliteStatement` typo** — the exported SQLite statement interface was misspelled `SqliteStepment` (a find/replace artifact from the v2 Route→Flow/Step rename). Renamed to `SqliteStatement`. Update any type imports.

### Internal

- Removed unreachable "ToolManager not available" fallback branches in `ResponseModal` — `agent.tool` is always initialized in the `Agent` constructor, so `getToolManager()` now returns a non-optional `ToolManager`.
- Fixed a layering inversion: prompt-cache config types (`PromptSectionType`, `PromptCacheConfig`, `SectionCompute`) moved from `core/PromptSectionCache` to `types/prompt-cache`. Core now imports them from `types/` instead of `types/` reaching into `core/`.
- De-duplicated re-exports in `types/index.ts` (removed redundant `export *` over explicit named exports).

### Dependencies

- Moved `@types/pg` to `devDependencies` (type-only, for an optional peer).
- Removed `@types/redis` (unused — the `RedisAdapter` defines its own `RedisClient` interface).
- Removed `vitest` from `devDependencies` (tests run on `bun:test`; `vitest` was never imported).
- Removed `mysql2` from peer dependencies (no MySQL adapter exists).
- Removed the `redis` (node-redis) peer-meta entry — the `RedisAdapter` targets `ioredis`.
- Pinned previously empty peer-dependency version ranges: `ioredis ^5.0.0`, `mongodb ^6.0.0`, `pg ^8.0.0`.

## [2.1.1]

### Fixed

- Fixed `ToolManager not available on agent` warning during initialization. `ResponseModal` was constructed before `ToolManager`, so `agent.tool` was `undefined` when `ResponsePipeline` captured it. Moved `ToolManager` initialization before `ResponseModal` in the `Agent` constructor.

## [2.1.0]

### ⚠️ BREAKING CHANGES

#### `PreDirective` removed — merged into `Directive`

- **What changed:** The `PreDirective` interface and its export have been removed entirely. The three pre-LLM-only fields (`appendPrompt`, `injectTools`, `halt`) now live directly on `Directive`. `SignalDirective` extends `Directive` directly.
- **Migration:** Replace any `import { PreDirective }` with `import { Directive }`. All hook return types (`onEnter`, `prepare`) now return `Directive` instead of `PreDirective`. The shape is identical — no code changes needed beyond the type annotation.
- **Runtime behavior:** Pre-LLM fields emitted from post-LLM hooks (`finalize`, `onComplete`) or persisted to `session.pendingDirective` are now ignored with a `WARN`-level log (previously `DEBUG`). This makes misuse visible in logs without crashing.

### Improved

- **Type variance fix:** `Directive` is now covariant in both `TContext` and `TData`, eliminating 15+ pre-existing type errors in internal pipeline code. The fix: `complete.next` uses `Directive<unknown, unknown>` (the chained directive doesn't need precise generics), and `injectTools` uses `Tool[]` (default params).
- **Cleaner `flow.merge`:** The merge function no longer casts through `Record<string, unknown>` for the pre-LLM fields — they're accessed directly on the typed `Directive`.
- **Docs:** Architecture page updated from "seven primitives" to "six primitives." All references to the PreDirective/Directive inheritance chain removed. The concepts page now explains pre-LLM fields as a lifetime rule enforced at runtime, not a type-system boundary.

### Docs

- Fixed dead links in docs landing page (`./guides/` and `./reference/` pointed to directories with no index file).
- Consolidated `docs/migration/README.md` — Route → Flow rename is now presented as part of the v1 → v2 guide, not a separate section.
- Removed standalone `docs/migration/route-to-flow.md` — content merged into v1-to-v2.md §3.

## [2.0.1]

### Fixed

- Updated all model references to current 2026 models: Gemini `gemini-3.1-flash-lite` / `gemini-3.1-pro-preview`, OpenAI `gpt-5.5` / `gpt-5.4`, Anthropic `claude-sonnet-4-6` / `claude-opus-4-7`.
- Fixed `docs/README.md` not rendering as the site homepage (added frontmatter with `type: overview`, `order: 0`).

## [2.0.0]

### ⚠️ BREAKING CHANGES

#### `Route` domain noun renamed to `Flow`

The `Route` domain noun has been renamed to `Flow` across the entire `@falai/agent` package. This is a clean break with no compatibility shims or dual-naming layer.

The verb form `route()` and the gerund "routing" are preserved — routing-as-an-action remains the correct verb for selecting a flow.

**Key renames:**

| Old | New |
|-----|-----|
| `Route` (class) | `Flow` |
| `RoutingEngine` (class) | `FlowRouter` |
| `RouteOptions` | `FlowOptions` |
| `RouteRef` | `FlowRef` |
| `RouteTransitionConfig` | `FlowTransitionConfig` |
| `RouteCompletionHandler` | `FlowCompletionHandler` |
| `RouteLifecycleHooks` | `FlowLifecycleHooks` |
| `RouteConfigurationError` | `FlowConfigurationError` |
| `agent.createRoute()` | `agent.createFlow()` |
| `agent.getRoutes()` / `agent.routes` | `agent.getFlows()` / `agent.flows` |
| `agent.nextStepRoute()` | `agent.nextStepFlow()` |
| `agent.getRoutingEngine()` | `agent.getFlowRouter()` |
| `AgentOptions.routes` | `AgentOptions.flows` |
| `AgentOptions.routeSwitchMargin` | `AgentOptions.flowSwitchMargin` |
| `session.currentRoute` | `session.currentFlow` |
| `session.routeHistory` | `session.flowHistory` |
| `END_ROUTE` / `END_ROUTE_ID` | Removed (implicit terminus) |
| `generateRouteId()` | `generateFlowId()` |
| `enterRoute()` | `enterFlow()` |
| `updateRouteStep()` (adapters) | `updateFlowStep()` |
| `'end_route'` / `'route_complete'` | `'flow_complete'` |

**Persistence changes:** All adapters rename `current_route` → `current_flow`, `route_history` → `flow_history`, and the `route` column/field → `flow`. Generated IDs now use the `flow_` prefix instead of `route_`.

See [Migration Guide](docs/migration/v1-to-v2.md#3-route--flow-rename) for upgrade instructions, per-adapter SQL/Mongo/Redis/OpenSearch migration snippets, and ID prefix migration guidance.

#### Flow completion releases the session to idle — no hardcoded farewell message

The completion path is now a pure state transition. The framework emits **no message of its own** when a flow completes. Every word delivered to the user comes from a developer-defined step prompt.

**What changed:**

- The internal `__COMPLETED__` synthetic step (with hardcoded `"Send a brief, natural farewell message…"` prompt) is **removed**.
- The hardcoded prompt directives shipped on every completion turn (`"Generate a natural, friendly farewell message"`, `"Do NOT mention task names…"`, `"Do NOT use words like 'tarefa', 'dados coletados'…"`, etc.) are **removed**.
- The hardcoded English fallback `"Thank you! I've recorded all the information for your <flow title>."` is **removed**.
- The completion-time LLM call (`handleFlowCompletion`'s `provider.generateMessage(...)` and `streamFlowCompletion`'s `provider.generateMessageStream(...)`) is **removed**. Completion no longer costs tokens.

**New idle-state semantics:**

When a flow completes (last step reached, `requiredFields` satisfied, or a `complete` directive fires) and `onComplete` does not produce a transition:

- `session.currentFlow` is set to `undefined`.
- `session.currentStep` is set to `undefined`.
- The corresponding `session.flowHistory` entry is updated with `completed: true` and `exitedAt: <now>`.
- The router excludes any flow whose most recent `flowHistory` entry is `completed: true` from candidate scoring on subsequent turns.
- If all flows are filtered out, the engine falls back to the no-flow response path (uses agent identity/personality only).

This eliminates the v1 bug where a session pinned `currentFlow` and `currentStep = '__COMPLETED__'` after completion and the router got stuck re-entering the last step on every subsequent turn.

#### `flow.reentrant: boolean` opt-in for re-routable flows

Added `FlowOptions.reentrant` (default `false`). When `true`, a flow can be re-selected by the router after it has completed in the current session — useful for "do another?" patterns (re-book, re-search, repeat-task). On re-entry, the engine clears every field declared in the flow's `requiredFields` and `optionalFields` so the flow starts fresh from its initial step. Fields not owned by this flow are preserved in `session.data`.

`onComplete` always wins over `reentrant`. If `onComplete` returns a target flow, the session transitions there immediately on completion; `reentrant` is consulted only when `onComplete` is absent or returns `undefined`.

```ts
const agent = new Agent({
  // ...
  flows: [
    {
      title: 'Search',
      reentrant: true,  // user can search again after completing
      requiredFields: ['query'],
      // ...
    },
  ],
});
```

#### New session utilities

- **`completeCurrentFlow(session, { clearOwnedFields? })`** — releases the session to idle state. Marks the active `flowHistory` entry as `completed: true`, clears `currentFlow` and `currentStep`, and (when `clearOwnedFields` is provided) removes those fields from `session.data` for `reentrant` re-entry.
- **`isFlowCompletedThisSession(session, flowId)`** — returns `true` when the flow's most recent `flowHistory` entry is `completed: true`. Used by the router to exclude completed flows.

Both are exported from `@falai/agent`.

**Migration:**

If your v1 code expected the framework to send a farewell message on completion, **add an explicit final step** with your own copy:

```ts
// Before (v1 — relied on framework-generated farewell)
flow({
  title: 'Onboarding',
  steps: [
    { id: 'name',  collect: ['name'] },
    { id: 'email', collect: ['email'] },
  ],
});

// After (v2 — author your own closing turn)
flow({
  title: 'Onboarding',
  steps: [
    { id: 'name',   collect: ['name']  },
    { id: 'email',  collect: ['email'] },
    { id: 'thanks', prompt: 'Thank the user warmly. Wish them a great day.' },
  ],
});
```

If your v1 code relied on the router re-entering the last step after completion, that loop is gone — the session is idle and the next turn either applies `onComplete`, re-enters a `reentrant` flow, or runs the no-flow fallback. To restore the v1 loop deliberately, set `reentrant: true` on the flow.

If your tests asserted on the framework's hardcoded farewell language (`"Thank you!"`, `"recorded all the information"`, etc.), update them to assert on your own step prompts instead.

See [`/.kiro/specs/v2-overhaul/flow-completion.md`](.kiro/specs/v2-overhaul/flow-completion.md) for the full design rationale and [docs/migration/v1-to-v2.md](docs/migration/v1-to-v2.md) for the consolidated v2 migration guide covering idle-state semantics, `onComplete` vs `reentrant` precedence, and the final-step idiom.

#### `END_ROUTE` / `endRoute()` removed — implicit terminus

The `END_ROUTE` symbol, `END_ROUTE_ID` constant, `Step.endRoute()` method, and `RouteOptions.endStep` configuration have been completely removed. Route/flow completion is now implicit: **the last step in a flow terminates the route automatically**.

**What changed:**

| Removed | Replacement |
|---------|-------------|
| `END_ROUTE` symbol | Just stop chaining — the last step is the terminus |
| `END_ROUTE_ID` constant | Removed entirely |
| `Step.endRoute()` method | Not needed — last `.nextStep(...)` is the final step |
| `StepResult.endRoute` property | Removed from the interface |
| `RouteOptions.endStep` / `Route.endStepSpec` | Move closing prompt into the last step's `prompt` |
| `StoppedReason: 'end_flow'` | `'flow_complete'` (covers both "all steps processed" and "last step reached") |
| `END_ROUTE` in `steps[]` array | Just end the array — last element is the terminus |

**Migration:**

```typescript
// Before (1.x)
route.initialStep
  .nextStep({ prompt: "Collect name", collect: ["name"] })
  .nextStep({ prompt: "Collect email", collect: ["email"] })
  .endRoute({ prompt: "Thanks for signing up!" });

// After (2.0)
route.initialStep
  .nextStep({ prompt: "Collect name", collect: ["name"] })
  .nextStep({ prompt: "Collect email", collect: ["email"] })
  .nextStep({ prompt: "Thanks for signing up!" });
// ↑ last step is the implicit terminus — no endRoute() needed

// Before: steps array with END_ROUTE
{ steps: [{ id: "step1", prompt: "..." }, END_ROUTE] }

// After: just end the array
{ steps: [{ id: "step1", prompt: "..." }] }
```

**Rationale:** The `END_ROUTE` sentinel was a special-case escape hatch. With implicit terminus, the developer just stops chaining and the flow ends — no sentinel needed. This simplifies the mental model and removes an entire category of "forgot to add END_ROUTE" bugs.

#### Guideline / Rule / Prohibition collapsed into `Instruction`

The three v1 behavioral primitives — `Guideline`, `Rule`, and `Prohibition` — are unified into a single `Instruction<TContext, TData>` type with a `kind: 'must' | 'never' | 'should'` discriminator. Field names align with the rest of the DSL (`route.when`, `step.prompt`):

```typescript
// 1.x
{ condition: "user is hesitant", action: "Offer to compare options." }
// or rules[]: { content: "..." }
// or prohibitions[]: { content: "..." }

// 2.0
{ kind: 'should', when: "user is hesitant", prompt: "Offer to compare options." }
{ kind: 'must',   prompt: "Always confirm the booking before charging." }
{ kind: 'never',  prompt: "Reveal payment internals." }
```

#### Migration table — Instruction unification

| 1.x type / field | 2.0 replacement |
|------------------|-----------------|
| `Guideline` type | `Instruction` |
| `ScopedGuidelines` type | `ScopedInstructions` |
| `AppliedGuideline` type | `AppliedInstruction` |
| `GuidelineMatch` type | (removed; drop) |
| `condition: ...` (on Guideline) | `when: ...` (on Instruction) |
| `action: ...` (on Guideline) | `prompt: ...` (on Instruction) |
| `Rule` type / `rules: Rule[]` | `instructions: Instruction[]` with `kind: 'must'` |
| `Prohibition` type / `prohibitions: Prohibition[]` | `instructions: Instruction[]` with `kind: 'never'` |
| `AgentOptions.guidelines` | `AgentOptions.instructions` |
| `AgentOptions.rules` | `AgentOptions.instructions` (`kind: 'must'`) |
| `AgentOptions.prohibitions` | `AgentOptions.instructions` (`kind: 'never'`) |
| `FlowOptions.guidelines` | `FlowOptions.instructions` |
| `FlowOptions.rules` | `FlowOptions.instructions` (`kind: 'must'`) |
| `FlowOptions.prohibitions` | `FlowOptions.instructions` (`kind: 'never'`) |
| `AgentResponse.appliedGuidelines` | `AgentResponse.appliedInstructions` |
| `AgentResponseStreamChunk.appliedGuidelines` | `AgentResponseStreamChunk.appliedInstructions` |
| `agent.evaluateGuidelines(...)` | (removed; evaluation is internal to prompt composition) |
| `route.evaluateGuidelines(...)` | (removed) |
| `step.evaluateGuidelines(...)` | (removed) |
| `agent.createGuideline(...)` | `agent.createInstruction(...)` |
| `agent.getGuidelines()` / `getRules()` / `getProhibitions()` | `agent.getInstructions()` |
| `agent.guidelines` / `rules` / `prohibitions` getters/setters | `agent.instructions` |
| `flow.createGuideline(...)` | `flow.createInstruction(...)` |
| `flow.getGuidelines()` / `getRules()` / `getProhibitions()` | `flow.getInstructions()` |
| `flow.guidelines` getter | `flow.instructions` |
| `step.addGuideline(...)` | `step.addInstruction(...)` |
| `step.getGuidelines()` | `step.getInstructions()` |
| `AgentOptions.compositionMode` / `CompositionMode` enum | Removed entirely (had no runtime effect; only `FLUID` was ever observed) |

#### Add `step.branches`: explicit, source-local fork primitive

Add `step.branches`: explicit, source-local fork primitive with `if` (code) and `when` (AI) conditions; coexists with the implicit-fork pattern. Branches are evaluated after the step's post-LLM phase and before linear successor selection. The first matching entry wins (declaration order). Code predicates run first to save tokens — AI conditions are only evaluated when `if` passes or is absent.

See [Branches documentation](docs/reference/branches.md) for full details.

#### Multi-step batching replaced with explicit `auto: true` steps

Replaced multi-step batching with explicit `auto: true` steps. `maxStepsPerBatch` removed, `BatchExecutor` and `BatchPromptBuilder` deleted, `auto` and `maxAutoStepsPerTurn` added. See [docs/migration/v1-to-v2.md](docs/migration/v1-to-v2.md).

#### Prompt shape: `## Instructions` (breaking runtime effect)

The rendered prompt section has changed shape. If you have tests or integrations that assert on prompt output, update them:

- **Section header** changed from `## Guidelines` to `## Instructions`.
- **Inline scope captions** are now prepended to each line: `[Always]`, `[In: <FlowTitle>]`, `[Step: <stepId>]`.
- **No numbering** — instructions are rendered as unordered list items (`- [Caption] text`).
- **No `Additional Context` trailer** — AI context strings from `when` conditions are no longer appended as a separate block.

Example rendered output:

```
## Instructions

- [Always] Be concise unless the user asks for detail.
- [In: Booking] Offer to compare two options before pushing for a decision.
- [Step: payment] If the card is declined, never retry without confirmation.
```

#### Agent identity consolidated into `persona`

`AgentOptions.description`, `AgentOptions.identity`, and `AgentOptions.personality` are removed. Use the new `AgentOptions.persona?: Template<TContext>` field — a single prompt covering role, tone, and self-concept. The `description` / `identity` / `personality` getters and setters on `Agent` are deleted with no shims.

`FlowOptions.identity` and `FlowOptions.personality` are removed too — agent identity is agent-level only. Flows shape behavior through `instructions`, not their own persona overrides.

#### Tool / EnhancedTool merged into `Tool`

`EnhancedTool` is removed. All metadata fields (`isReadOnly`, `isConcurrencySafe`, `isDestructive`, `interruptBehavior`, `maxResultSizeChars`, `validateInput`, `checkPermissions`) live directly on `Tool`. Existing `Tool` definitions continue to work; references to `EnhancedTool` must be replaced with `Tool`.

The optional `Tool.name` field is removed. **`Tool.id` is the sole identifier**, used for both registry lookup and LLM-facing display.

`Agent.createTool()` is removed; declare tools via `AgentOptions.tools` or pass them through `StepOptions.tools`.

#### Directive replaces `FlowTransitionConfig` / `FlowCompletionHandler`

The legacy transition shapes are removed. `FlowTransitionConfig` collapses into `Directive`. `FlowCompletionHandler` becomes `hooks.onComplete` returning a `Directive`. Top-level `FlowOptions.onComplete` is now a string-only target (flow id or title); handler form moves to `hooks.onComplete`.

#### `Flow.skipIf` removed

`Flow.skipIf` (which was already hardcoded to `undefined` after the v2 condition split) and `Flow.evaluateSkipIf()` are deleted. Use `Flow.if` for code-evaluated activation guards and `Flow.when` for AI-evaluated guards.

#### `FlowOptions` scope cleanup — agent-level only fields

The following `FlowOptions` fields are removed; they exist agent-level only:

| Removed from FlowOptions | Replacement |
|--------------------------|-------------|
| `identity` | Agent-level `persona` |
| `personality` | Agent-level `persona` |
| `guidelines` | `instructions` (per Instruction unification above) |
| `rules` | `instructions` with `kind: 'must'` |
| `prohibitions` | `instructions` with `kind: 'never'` |
| `terms` | Agent-level `terms` only |
| `knowledgeBase` | Agent-level `knowledgeBase` only |

Corresponding `Flow` methods are also removed: `Flow.createTerm()`, `Flow.getTerms()`, `Flow.getKnowledgeBase()`.

#### `StepOptions.step` field removed

The `step?: StepRef | symbol` field on `StepOptions` is removed (it was dead since `END_FLOW` removal — implicit terminus replaces all sentinel-based wiring).

#### Deprecated `Agent` accessor cleanup

The following deprecated methods and accessors are removed from `Agent` with no shims:

`getCurrentSession()`, `setCurrentSession()`, `clearCurrentSession()` (session lifecycle moved into `SessionManager`); `getSchema()`, `getKnowledgeBase()` (read via `agent.schema` / `agent.knowledgeBase` instead); `description` / `identity` / `personality` getters and setters (folded into `persona`); `compositionMode` getter and setter (composition mode had no runtime effect).

### Added

- **Flow completion handling** — idle-state semantics, the absence of hardcoded farewell, `onComplete` vs `reentrant` precedence, and the "add a final step for closing copy" idiom (see [docs/migration/v1-to-v2.md](docs/migration/v1-to-v2.md)).
- **`Instruction<TContext, TData>`** — new exported type unifying `Guideline`, `Rule`, and `Prohibition` behind a `kind: 'must' | 'never' | 'should'` discriminator with `when` (AI-evaluated) and `prompt` fields.
- **`ScopedInstructions<TContext, TData>`** — new exported type that carries the three scope buckets (`global`, `flow?`, `step?`) through the prompt pipeline.
- **`AppliedInstruction`** — new exported type (`{ id: string; scope: 'global' | 'flow' | 'step'; scopeRef?: string }`) for deterministic observability of which instructions were active during a turn.
- **`AgentResponse.appliedInstructions`** — new optional field populated with the set of instructions that passed `enabled` and `when` evaluation and were rendered into the prompt for that turn. Deterministic (derived from rendering, not from LLM self-report).
- **`AgentResponseStreamChunk.appliedInstructions`** — same field, populated on the final (`done: true`) chunk.

## [1.3.0]

### ⚠️ BREAKING CHANGES

#### `Route` domain noun renamed to `Flow`

The `Route` domain noun has been renamed to `Flow` across the entire `@falai/agent` package. This is a clean break with no compatibility shims or dual-naming layer.

**What changed:**

- All `Route`-prefixed symbols, types, methods, fields, and constants have been renamed to their `Flow`-prefixed equivalents (e.g. `Route` → `Flow`, `RouteOptions` → `FlowOptions`, `RoutingEngine` → `FlowRouter`, `RouteConfigurationError` → `FlowConfigurationError`).
- Agent API: `agent.createRoute()` → `agent.createFlow()`, `agent.getRoutes()` → `agent.getFlows()`, `agent.routes` → `agent.flows`, `AgentOptions.routes` → `flows`, `AgentOptions.routeSwitchMargin` → `flowSwitchMargin`.
- Session shape: `session.currentRoute` → `session.currentFlow`, `session.routeHistory` → `session.flowHistory`.
- Constants: `END_ROUTE` → `END_FLOW`, `END_ROUTE_ID` → `END_FLOW_ID`.
- Utilities: `generateRouteId()` → `generateFlowId()`, `enterRoute()` → `enterFlow()`.
- Adapter method: `updateRouteStep()` → `updateFlowStep()` on all seven persistence adapters.

**Preserved (verb form and gerund):** The method name `route()` on `FlowRouter` and the gerund "routing" are preserved — routing-as-an-action remains the correct verb for selecting a flow.

**Persistence changes (operators must run migration):** All adapters rename persisted columns/fields: `current_route` → `current_flow`, `route_history` → `flow_history`, and the `route` column/field → `flow`. Operators must run the appropriate migration for their backend before upgrading.

**ID prefix changed:** Generated IDs now use the `flow_` prefix instead of `route_`. Existing stored IDs with the `route_` prefix must be migrated.

See the [Migration Guide](docs/migration/v1-to-v2.md#3-route--flow-rename) for the full rename table, per-adapter SQL/Mongo/Redis/OpenSearch migration snippets, and ID prefix migration guidance.

## [1.2.8]

### Fixed

- **Duplicate step-entry corrupts session when `requires` fields are missing**: `ResponsePipeline.determineNextStep()` unconditionally called `enterStep()` on the candidate step, mutating `session.currentStep` before `ResponseModal.processRouteResponse()` could evaluate its `requires` guard. When the guard fired, it read the already-advanced step from the session and stayed on it — effectively entering the step it was supposed to block. The pipeline now checks `requires` fields against `session.data` before calling `enterStep()`; if any are missing, it returns the session unchanged and falls back to the current step.

- **Gemini SDK logs "non-text parts thoughtSignature" warning on every response**: The `safeExtractText` method used the SDK's `.text` getter as the primary path, which internally logs a warning when the response contains non-text parts like `thoughtSignature` (thinking/reasoning tokens). Inverted the extraction logic to always read text parts directly from `candidates[0].content.parts`, bypassing the getter entirely. The `.text` getter is now only a last-resort fallback when no candidates structure exists.

## [1.2.7]

### Fixed

- **Tool loop retry used stale `toolCalls` reference for history**: The fallback LLM call added in 1.2.6 iterated `toolCalls` to build tool-result history, but `toolCalls` had already been reassigned to the empty follow-up array when the while loop broke. The retry call received no tool context, so the LLM couldn't reason about what the tools returned. Now uses `toolResultsMap` directly — which accumulates all tool executions throughout the loop — to build the history for the retry call.

## [1.2.6]

### Fixed

- **Tool loop returns placeholder message when follow-up LLM call is empty**: After `executeUnifiedToolLoop` executed tools successfully, the follow-up LLM call could return an empty or undefined message. Because `processRouteResponse` only overwrites the original message when `toolResult.finalMessage` is truthy, the initial tool-invocation placeholder (e.g. "Deixe-me verificar...") was sent to the user as the final response — making it look like the agent hung. The tool loop now detects this case and makes one additional LLM call with no tools available, forcing a proper text response from the tool results.

## [1.2.5]

### Fixed

- **Session state not synced after `stream()`/`generate()` completion**: The modern APIs (`chat()`, `stream()`, `generate()`) completed without writing the finalized session (route, step, data) back to `agent.session.current`, causing route progress to be lost between turns. Added `syncSession()` to `SessionManager` and explicit sync calls in `stream()` and `generate()` after completion.

- **AbortSignal not propagated to sub-calls**: `generateUnifiedResponse()` passed `signal: undefined` to both `processRouteResponse()` and `handleRouteCompletion()`, preventing cancellation from reaching the AI provider. The caller's signal is now forwarded correctly.

- **Tool follow-up structured data discarded**: `executeUnifiedToolLoop()` did not return `followUpResult.structured`, and `processRouteResponse()` passed the original (pre-tool) response to `collectDataFromResponse()` instead of the follow-up. The tool loop now returns structured data, and `processRouteResponse()` uses it when available.

- **Optional-only routes incorrectly marked as complete**: Routes with only `optionalFields` (no `requiredFields`) had `isComplete()` returning `true` and `getCompletionProgress()` returning `1.0`, making them unselectable by the routing engine. They now correctly return `false`/`0` and can only complete via `END_ROUTE`.

## [1.2.4]

### Fixed

- **Tool result data discarded in tool loop**: The tool execution loop in both `ResponseModal` and `ResponsePipeline` was replacing actual tool result data with a static `"Tool executed successfully"` string when building conversation history for follow-up AI calls. The AI could never see what a tool actually returned, making it unable to reason about tool outputs or incorporate them into its responses. Tool results are now serialized from the `ToolExecutionResult.data` field and passed through as the tool message content in conversation history.

## [1.2.3]

### Fixed

- **Aggressive route switching (Scheduling Route)**: Fixed an issue where the AI would aggressively switch to specific routes (like scheduling) even when not explicitly requested by the user. 
  - **Route IDs in Prompt**: Route IDs and `skipIf` conditions are now explicitly shown in the prompt's `Available Routes` section alongside the route titles, removing ambiguity during the AI's route scoring phase.
  - **Removed Global Condition Leak**: Fixed a prompt construction flaw where all `when` conditions from all eligible routes were combined into a single global list at the end of the routing prompt. Conditions are now properly scoped only to their respective routes, preventing the AI from misinterpreting a specific route's trigger condition as a global conversation objective.


## [1.2.2]

### Added

- **Session resume: honor pre-set route and step on first message** — When a session has a `currentRoute` (and optionally `currentStep`) already set and the conversation history contains no user messages (system-only or empty), the routing engine now skips AI route/step selection and honors the pre-set position. This supports two key scenarios:
  - **Persistence-based resume**: A session loaded from storage already has route/step state; the first system message should pick up where it left off rather than re-routing.
  - **Programmatic placement**: A developer creates a session with `createSession({ currentRoute: { id, title }, currentStep: { id } })` to start the user at a specific point in the flow.

  If the first message is a user message, normal AI routing still applies — the user's intent takes priority over any pre-set state.

## [1.2.1]

### Fixed

- **Critical: Agent stuck on initial step** — The 1.2.0 "native history format" change removed history from the prompt but providers weren't updated to use `input.history` for building conversation messages. The LLM received zero conversation context, causing it to regenerate the initial greeting on every turn.

### Changed

- **Providers now use native multi-turn messages** — All four providers (Anthropic, OpenAI, Gemini, OpenRouter) now build proper multi-turn conversation messages from `input.history` instead of relying on history being embedded in the prompt string. This means the LLM sees real user/assistant turns rather than JSON-serialized events, improving response quality and reducing token usage.

- **`GenerateMessageInput.history` type changed from `Event[]` to `HistoryItem[]`** — The history field now accepts the native `HistoryItem[]` format (with `user`/`assistant`/`tool`/`system` roles) that maps directly to each provider's API. Callers updated accordingly.

- **History removed from system prompt** — `addInteractionHistory()` and `addLastMessage()` are no longer called in `buildResponsePrompt()` and `buildFallbackPrompt()`. The `lastMessage` param is removed from `BuildResponsePromptParams`. History flows exclusively through the provider's native message format.

- **`addInteractionHistory()` deprecated for response generation** — The method remains on `PromptComposer` because it's still used by `RoutingEngine` and `BatchPromptBuilder` for route/step selection prompts (single-shot classification calls where history belongs in the prompt). It is no longer used for main response generation.

## [1.2.0]

### Added

- **StreamingToolExecutor**: New concurrency-controlled tool executor that begins executing tools as they arrive from the LLM stream. Read-only tools (`isConcurrencySafe`) run in parallel; write tools run serially. Includes sibling abort propagation, configurable max parallel executions (default: 10), progress message yielding, and per-tool result size budgeting.

- **CompactionEngine**: New context management component that automatically reduces conversation history size when approaching token limits. Applies strategies in order of cost: tool result budgeting → micro-compaction → LLM summarization. Configurable via `compaction` option on `AgentOptions`.

- **EnhancedTool interface**: Extends the existing `Tool` interface with optional metadata methods: `isConcurrencySafe`, `isReadOnly`, `isDestructive`, `interruptBehavior`, `validateInput`, `checkPermissions`, and `maxResultSizeChars`. Existing `Tool` definitions continue to work without modification.

- **Validation and permission gates in ToolManager**: `validateInput` and `checkPermissions` on `EnhancedTool` are checked before calling the handler. If validation fails or permission is denied, the handler is never invoked.

- **`executeWithConcurrency` method on ToolManager**: Async generator that creates a `StreamingToolExecutor`, resolves tools, queues them, and yields `ToolExecutionUpdate` results in request order.

- **PromptSectionCache**: New prompt generation optimization component that memoizes static prompt sections (agent identity, glossary, knowledge base, route descriptions) across turns and recomputes dynamic sections per-turn. Configurable via `promptCache` option on `AgentOptions` with `enabled` and `volatileKeys` settings. Supports targeted invalidation via `invalidate(key)` and full reset via `invalidateAll()`.

- **Native history format**: Conversation history is now sent as native provider messages via `GenerateMessageInput.history` instead of being JSON-serialized into the system prompt. This saves tokens and lets providers optimize for their native message format. The `addInteractionHistory()` and `addLastMessage()` methods on `PromptComposer` are deprecated but remain functional for backward compatibility.

- **Automatic cache invalidation**: `agent.updateContext()` invalidates context-dependent cached sections, session changes invalidate all cached sections, and route switches invalidate route-dependent sections — no manual cache management required.

- **Documentation**: Guides for streaming tool execution, context compaction, EnhancedTool interface, and prompt optimization in `docs/`. Updated API overview and README.

- **Examples**: Working examples for streaming tool execution, context compaction, and enhanced tool metadata in `examples/`.

### Fixed

- **Provider tool call handling across all providers**: Tool-only responses (no text content) no longer throw `"No response from ..."`. All four providers (Anthropic, OpenAI, OpenRouter, Gemini) now correctly handle responses that contain only function calls.

- **Streaming tool calls dropped without JSON schema**: In OpenAI and Gemini streaming, tool calls were silently lost when no JSON schema was configured because `structured` was only set for JSON schema responses. Tool calls now always produce a `structured` response.

- **Structured response spread order**: All providers had `{ message, toolCalls, ...structured }` which allowed a parsed JSON schema response to overwrite actual `toolCalls`. Fixed to `{ ...structured, message, toolCalls }` so real tool calls always take precedence.

- **Gemini tool parameter schema conversion**: Tool parameters were passed as raw JSON Schema to Gemini's `FunctionDeclaration.parameters`, which expects Gemini's own `Schema` type. Parameters now go through `adaptSchemaForGemini()` with proper type enum conversion and empty-object handling.

- **Gemini `response.text` / `chunk.text` safety**: The `.text` getter can throw when the response contains only function calls. Added `safeExtractText()` that falls back to manually extracting text parts from candidates.

- **Gemini abort signal passthrough**: `AbortSignal` from `input.signal` is now forwarded to both `generateContent` and `generateContentStream` via `config.abortSignal`.

## [1.1.3]

### Changed

- **Agent identity prompt rewrite**: `addAgentMeta` now produces an imperative identity block instead of passive key-value metadata. The agent name is framed as a self-referencing instruction, identity and personality are rendered as directives, and goal/description provide supporting context. This makes the LLM far more likely to internalize and consistently use the agent's configured persona.

- **Agent-level rules and prohibitions in identity block**: `addAgentMeta` now renders agent-level `rules` and `prohibitions` directly inside the identity section, reinforcing them as core behavioral constraints rather than detached instructions. This ensures they are present in every prompt path (response, routing, step selection, batch, fallback) without requiring each caller to merge them separately.

### Fixed

- **Duplicate agent rules/prohibitions in prompts**: Agent-level rules and prohibitions were being injected twice in response prompts — once via `addAgentMeta` and again when `ResponseModal` merged `agent.getRules()` with `route.getRules()` before passing them to `buildResponsePrompt`. The same duplication existed in `BatchPromptBuilder`. All call sites now pass only route-level rules/prohibitions, since agent-level ones are handled by `addAgentMeta`.

## [1.1.2]

### Fixed

- **Internal data leaking into user-facing messages**: Route completion messages were including raw collected data (e.g., `"Dados coletados: prospectName: Aco Alimentos, prospectSector: ..."`) and internal task names (e.g., `"Tarefa concluída: Prospecção Inicial"`). The completion directives now explicitly instruct the AI to generate natural, conversational farewell messages without echoing field names, JSON keys, or internal information.

- **Structured data fields echoed as message content**: The AI would sometimes return data collection field values (e.g., `"Cidade: IBITINGA"`, `"Estado: SP"`) inside the `message` property instead of keeping them as separate structured JSON fields. Strengthened the response format instructions, JSON schema descriptions, and batch prompt builder across all response paths (single-step, batch, and streaming) to explicitly separate user-facing message content from extracted data.

- **Premature route completion**: Routes were ending prematurely (skipping steps) if all required fields were collected, tracking `isComplete()` instead of following the step flow to `END_ROUTE`. Required fields now act only as validation gates, not completion triggers, allowing conversational step chains to complete properly.

- **Pre-extraction extracting from context**: The data pre-extraction flow (which checks if the user provided required data before running steps) was inappropriately being given the full context (which can include pre-existing system database records, lead info, etc.). This caused the AI to extract data from the system's own context rather than from what the user actually said. The pre-extraction call now only sees the user's message history and an isolated empty object as context.

### Changed

- **Completion prompt defaults**: The default `endStep` prompt changed from `"Summarize what was accomplished and confirm completion based on the conversation history and collected data"` to a natural farewell instruction that prevents data dumping.

- **Response schema `message` descriptions**: All JSON schema definitions for the `message` field now explicitly state it must be a natural, conversational response and must NOT contain field names, raw data, or internal information. This applies to `ResponseEngine`, `BatchPromptBuilder`, and `ResponseModal` batch/completion schemas.

## [1.1.1]

### Added

- **`createSession` function overloading**: `createSession` now accepts either the classic `(sessionId?, metadata?)` signature or a `Partial<SessionState<TData>>` object that is merged with sensible defaults. This allows pre-populating any session fields (data, history, currentRoute, etc.) in a single call.

```typescript
// Classic (unchanged)
const session = createSession<MyData>("session_123", { userId: "u1" });

// New: partial state overload
const session = createSession<MyData>({
  id: "session_123",
  data: { name: "Alice" },
  history: restoredHistory,
});
```

- **`createSessionId` public export**: The `createSessionId()` utility is now exported from the package, allowing consumers to generate unique session IDs without creating a full session object.

### Changed

- **Standardized session ID generation**: All adapters (`MongoAdapter`, `PostgreSQLAdapter`, `PrismaAdapter`, `MemoryAdapter`, `OpenSearchAdapter`) and core classes (`SessionManager`, `BatchExecutor`) now use `createSessionId()` or `createSession()` instead of inline `session_${Date.now()}_${Math.random()...}` patterns. This ensures consistent ID formatting across the codebase.

## [1.1.0]

### Breaking Changes

- **`maxStepsPerBatch` defaults to `1`**: Steps now execute one at a time by default, restoring the classic single-step behavior. Previously, all eligible steps would batch together in a single LLM call, which was confusing when steps had no `collect`/`requires` fields and the entire route would complete in one shot. Set `maxStepsPerBatch` to a higher value or `Infinity` to re-enable batching.

### Added

- **`maxStepsPerBatch` option**: New `AgentOptions` property to control how many steps execute in a single batch. Accepts any positive integer or `Infinity` (default: `1`).
- **`max_steps_reached` stopped reason**: New `StoppedReason` value emitted when a batch stops because it hit the `maxStepsPerBatch` limit.

### Migration from 1.0.x

If you relied on multi-step batching, add `maxStepsPerBatch: Infinity` to your agent options to restore the previous behavior:

```typescript
const agent = new Agent({
  name: "Assistant",
  provider: provider,
  maxStepsPerBatch: Infinity, // Restore v1.0.x batching behavior
});
```

## [1.0.2]

### Fixed

- **Sticky route switching**: Route switching now uses a score margin strategy instead of a loose absolute threshold. The agent stays on the current route unless an alternative scores higher by a configurable margin (`routeSwitchMargin`, default: 15). This prevents unnecessary route flip-flopping on marginal score differences.

- **Dead routing code removal**: Removed `decideRouteFromScores`, `switchThreshold`, `maxCandidates`, `allowRouteSwitch`, and `RoutingDecisionWithRoute` — all were configured but never wired into the actual routing flow.

- **Documentation dead links**: Fixed all broken internal links across docs (wrong relative paths to `examples/`, references to non-existent files like `AGENT.md`, `TOOLS.md`, `PROVIDERS.md`, `PERSISTENCE.md`, `ADAPTERS.md`, `tool-execution.md`, and missing example files).

### Added

- **`routeSwitchMargin` option**: New `AgentOptions` property to configure how much higher an alternative route must score before the agent switches away from the current route. Accepts values 0-100 (default: 15).

## [1.0.1]

### Fixed

- **Step `requires` enforcement**: Steps with `requires` fields that reference uncollected data now correctly block advancement. The agent stays at the current step instead of skipping ahead, and emits a console warning identifying the missing fields and the step that cannot proceed. This applies to both streaming and non-streaming response paths.

- **Dynamic schema generation from `collect` fields**: When no agent-level `schema` is provided, the response schema and data collection prompts are now dynamically generated from the step's `collect` fields (defaulting to `type: "string"` per field). Previously, collect fields were silently ignored if no schema was defined, resulting in no structured extraction.

### Added

- **Agent-level `rules` and `prohibitions`**: `AgentOptions` now accepts `rules` and `prohibitions` arrays (same `Template` type used by routes). These are merged with route-level rules/prohibitions and included in all prompt compositions — single-step, batch, and streaming. See [Agent Rules & Prohibitions](docs/core/agent/rules-and-prohibitions.md) for details.
