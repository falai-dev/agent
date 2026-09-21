/**
 * The understand gate: replays the labelled set in ./cases.ts through the
 * real Agent on every provider whose key is in the environment, with the
 * speak call silenced, and reports how often the one understand call agrees
 * with the labels, what it costs and how long it takes.
 *
 * Run:  GEMINI_API_KEY=... ZAI_API_KEY=... bun run eval:understand
 * Flags:
 *   --min 0.9      lowest flow agreement that passes (exit 1 below it)
 *   --repeat 3     judge every case N times; reports how often the decision was the same
 *   --only r01,f04 run these case ids only
 *   GEMINI_MODEL / ZAI_MODEL / DEEPSEEK_MODEL / OPENROUTER_MODEL pick the model
 *   (defaults: gemini-2.5-flash, glm-5.3-flash, deepseek-chat, z-ai/glm-5.3-flash)
 *
 * 4.0.0 ships only when every provider the products run on passes.
 */

import {
  DeepSeekProvider,
  GeminiProvider,
  OpenRouterProvider,
  ZaiProvider,
  type AgentStructuredResponse,
  type AiProvider,
  type GenerateMessageInput,
  type GenerateMessageOutput,
  type GenerateMessageStreamChunk,
  type History,
  type Session,
} from "../../src/index.js";
import { cases, f, flows, mentionFlowIds, messageFlowIds, type Case } from "./cases.js";

// ── Flags ───────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const MIN = Number(flag("min") ?? 0.9);
const REPEAT = Math.max(1, Number(flag("repeat") ?? 1));
const ONLY = flag("only")?.split(",").map((s) => s.trim()).filter(Boolean);

// ── A provider that remembers what each call cost ───────────────────────

interface CallRecord {
  schemaName: string;
  ms: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedInputTokens?: number;
}

class Metered implements AiProvider {
  readonly name: string;
  readonly capabilities: AiProvider["capabilities"];
  readonly calls: CallRecord[] = [];

  constructor(private readonly inner: AiProvider) {
    this.name = inner.name;
    this.capabilities = inner.capabilities;
  }

  async generateMessage<TContext = unknown, TStructured = AgentStructuredResponse>(
    input: GenerateMessageInput<TContext>,
  ): Promise<GenerateMessageOutput<TStructured>> {
    const started = performance.now();
    const output = await this.inner.generateMessage<TContext, TStructured>(input);
    const meta = output.metadata ?? {};
    this.calls.push({
      schemaName: input.parameters?.schemaName ?? "(unnamed)",
      ms: performance.now() - started,
      promptTokens: numberOrUndefined(meta.promptTokens),
      completionTokens: numberOrUndefined(meta.completionTokens),
      cachedInputTokens: numberOrUndefined(meta.cachedInputTokens),
    });
    return output;
  }

  generateMessageStream<TContext = unknown, TStructured = AgentStructuredResponse>(
    input: GenerateMessageInput<TContext>,
  ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
    return this.inner.generateMessageStream<TContext, TStructured>(input);
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

// ── One case, one verdict ───────────────────────────────────────────────

interface Verdict {
  id: string;
  flow: boolean;
  mentions: boolean;
  fields: boolean;
  gotFlow: string | null;
  gotMentions: string[];
  gotFields: Record<string, string>;
  setupFailed?: string;
}

const isMessageFlow = (id: string): boolean => (messageFlowIds as readonly string[]).includes(id);
const isMentionFlow = (id: string): boolean => (mentionFlowIds as readonly string[]).includes(id);
const norm = (value: unknown): string => String(value ?? "").trim().toLowerCase();

async function judge(agent: ReturnType<typeof f.agent>, c: Case, attempt: number): Promise<Verdict> {
  const sessionId = `eval:${c.id}:${attempt}`;
  let session: Session<unknown> | undefined;
  let history: History = [];
  if (c.setup) {
    const r0 = await agent.turn({ sessionId, message: c.setup.message, id: "m0" });
    const startedFlow = r0.started[0]?.flowId;
    if (startedFlow !== c.setup.flow || !r0.session.runs.some((run) => run.status === "asking")) {
      return { id: c.id, flow: false, mentions: false, fields: false, gotFlow: null, gotMentions: [], gotFields: {}, setupFailed: `setup started ${startedFlow ?? "nothing"}, wanted ${c.setup.flow} asking` };
    }
    session = r0.session;
    history = [
      { role: "user", content: c.setup.message },
      { role: "assistant", content: r0.messages.map((m) => m.text).join("\n") },
    ];
  }
  const r = await agent.turn({
    sessionId,
    session,
    history,
    message: c.message,
    id: "m1",
    silenced: { reason: "avaliação", understand: true },
  });
  const gotFlow = r.started.map((s) => s.flowId).find(isMessageFlow) ?? null;
  const gotMentions = r.started.map((s) => s.flowId).filter(isMentionFlow).sort();
  const data: Record<string, unknown> = r.session.data;
  const wantFields = c.expect.fields ?? {};
  const gotFields = Object.fromEntries(Object.keys(wantFields).map((k) => [k, norm(data[k])]));
  const wantMentions = [...(c.expect.mentions ?? [])].sort();
  return {
    id: c.id,
    flow: gotFlow === c.expect.flow,
    mentions: JSON.stringify(gotMentions) === JSON.stringify(wantMentions),
    fields: Object.entries(wantFields).every(([k, v]) => gotFields[k] === norm(v)),
    gotFlow,
    gotMentions,
    gotFields,
  };
}

// ── Providers from the environment ──────────────────────────────────────

function providers(): Array<{ label: string; provider: AiProvider }> {
  const out: Array<{ label: string; provider: AiProvider }> = [];
  const gemini = process.env.GEMINI_API_KEY;
  if (gemini) {
    const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    out.push({ label: `gemini (${model})`, provider: new GeminiProvider({ apiKey: gemini, model }) });
  }
  const zai = process.env.ZAI_API_KEY;
  if (zai) {
    const model = process.env.ZAI_MODEL ?? "glm-5.3-flash";
    out.push({ label: `zai (${model})`, provider: new ZaiProvider({ apiKey: zai, model }) });
  }
  const deepseek = process.env.DEEPSEEK_API_KEY;
  if (deepseek) {
    const model = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
    out.push({ label: `deepseek (${model})`, provider: new DeepSeekProvider({ apiKey: deepseek, model }) });
  }
  const openrouter = process.env.OPENROUTER_API_KEY;
  if (openrouter) {
    const model = process.env.OPENROUTER_MODEL ?? "z-ai/glm-5.3-flash";
    out.push({ label: `openrouter (${model})`, provider: new OpenRouterProvider({ apiKey: openrouter, model }) });
  }
  return out;
}

// ── Report ──────────────────────────────────────────────────────────────

const pct = (n: number, d: number): string => (d ? `${Math.round((100 * n) / d)}% (${n}/${d})` : "n/a");
const avg = (xs: Array<number | undefined>): string => {
  const known = xs.filter((x): x is number => typeof x === "number");
  return known.length ? String(Math.round(known.reduce((a, b) => a + b, 0) / known.length)) : "?";
};

async function main(): Promise<number> {
  const selected = ONLY ? cases.filter((c) => ONLY.includes(c.id)) : cases;
  const unknown = ONLY?.filter((id) => !cases.some((c) => c.id === id)) ?? [];
  if (unknown.length) {
    console.error(`Unknown case id(s): ${unknown.join(", ")}. Known ids: ${cases.map((c) => c.id).join(", ")}.`);
    return 2;
  }
  const targets = providers();
  if (!targets.length) {
    // Still build the agent so a broken fixture fails here, not on a paid run.
    f.agent({ name: "Ana", provider: new GeminiProvider({ apiKey: "unused", model: "unused" }), flows, idle: { prompt: "Responda pela empresa." } });
    console.log(`No provider key found. Set GEMINI_API_KEY and/or ZAI_API_KEY and run again.\n${selected.length} case(s) ready; the fixture agent builds.`);
    return 2;
  }

  let failed = false;
  for (const { label, provider } of targets) {
    const metered = new Metered(provider);
    const agent = f.agent({
      name: "Ana",
      persona: "Assistente comercial de uma empresa de software de vendas, direta e simpática.",
      provider: metered,
      flows,
      idle: { prompt: "Responda pela empresa, sem inventar preços." },
    });

    const verdicts = new Map<string, Verdict[]>();
    for (const c of selected) {
      const runs: Verdict[] = [];
      for (let attempt = 0; attempt < REPEAT; attempt++) {
        try {
          runs.push(await judge(agent, c, attempt));
        } catch (error) {
          runs.push({ id: c.id, flow: false, mentions: false, fields: false, gotFlow: null, gotMentions: [], gotFields: {}, setupFailed: `threw: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      verdicts.set(c.id, runs);
      const first = runs[0];
      const mark = first.flow && first.mentions && first.fields ? "ok  " : "FAIL";
      process.stdout.write(`  ${mark} ${c.id}${first.setupFailed ? `  (${first.setupFailed})` : ""}\n`);
    }

    const all = [...verdicts.values()].flat();
    const withMentions = all.filter((v) => (selected.find((c) => c.id === v.id)?.expect.mentions?.length ?? 0) > 0 || v.gotMentions.length > 0);
    const withFields = all.filter((v) => Object.keys(selected.find((c) => c.id === v.id)?.expect.fields ?? {}).length > 0);
    const understand = metered.calls.filter((c) => c.schemaName === "understand");
    const stable = [...verdicts.values()].filter((runs) => runs.every((v) => v.gotFlow === runs[0].gotFlow)).length;
    const flowRate = all.filter((v) => v.flow).length / all.length;

    console.log(`\n${label}`);
    console.log(`  flow agreement      ${pct(all.filter((v) => v.flow).length, all.length)}`);
    console.log(`  mention agreement   ${pct(withMentions.filter((v) => v.mentions).length, withMentions.length)}   (cases that expected or produced a mention)`);
    console.log(`  field agreement     ${pct(withFields.filter((v) => v.fields).length, withFields.length)}   (cases that expected fields)`);
    if (REPEAT > 1) console.log(`  same flow decision  ${pct(stable, verdicts.size)} across ${REPEAT} repeats`);
    console.log(`  understand calls    ${understand.length}, avg ${avg(understand.map((c) => c.ms))} ms, avg ${avg(understand.map((c) => c.promptTokens))} prompt + ${avg(understand.map((c) => c.completionTokens))} completion tokens, avg ${avg(understand.map((c) => c.cachedInputTokens))} cached`);
    console.log(`  all calls           ${metered.calls.length} (setup turns spend a speak call each)`);

    const failures = all.filter((v) => !(v.flow && v.mentions && v.fields));
    if (failures.length) {
      console.log(`  failures:`);
      for (const v of failures) {
        const c = selected.find((x) => x.id === v.id)!;
        const parts: string[] = [];
        if (!v.flow) parts.push(`flow ${JSON.stringify(v.gotFlow)} wanted ${JSON.stringify(c.expect.flow)}`);
        if (!v.mentions) parts.push(`mentions ${JSON.stringify(v.gotMentions)} wanted ${JSON.stringify(c.expect.mentions ?? [])}`);
        if (!v.fields) parts.push(`fields ${JSON.stringify(v.gotFields)} wanted ${JSON.stringify(c.expect.fields)}`);
        if (v.setupFailed) parts.push(v.setupFailed);
        console.log(`    ${v.id}  "${c.message}"\n          ${parts.join("; ")}`);
      }
    }
    if (flowRate < MIN) {
      failed = true;
      console.log(`  BELOW THE BAR: flow agreement ${Math.round(flowRate * 100)}% < ${Math.round(MIN * 100)}%`);
    }
  }
  return failed ? 1 : 0;
}

process.exit(await main());
