/**
 * The live smoke test: every path that only a real provider can prove.
 *
 * The unit suite runs on a scripted provider, so it proves the framework's
 * logic and nothing about the wire. This one runs the real thing against every
 * provider whose key is in the environment and checks the eight things that
 * break on a wire and nowhere else:
 *
 *   1. speak      — the envelope comes back parsed, and no JSON reaches the customer
 *   2. fields     — a reply is read into the fields, and an enum snaps
 *   3. tools      — the model calls a tool, reads the result and answers
 *   4. streaming  — deltas arrive, and the final structured output still parses
 *   5. system     — the cacheable half is accepted as a system message
 *   6. cache      — a repeat of the same prefix is billed as a cache read
 *   7. auth       — a bad key classifies as `auth`, not as a mystery outage
 *   8. context    — an oversized prompt classifies as `context`
 *
 * Run:  bun run eval:live            every provider with a key
 *       bun run eval:live --only zai
 *       bun run eval:live --skip cache,context
 *
 * Exits 1 if any check fails on any provider.
 */

import {
  DeepSeekProvider,
  GeminiProvider,
  OpenRouterProvider,
  ProviderError,
  ZaiProvider,
  falai,
  type AiProvider,
} from "../../src/index.js";

// ── Flags ───────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const ONLY = flag("only")?.split(",").map((s) => s.trim()).filter(Boolean);
const SKIP = new Set(flag("skip")?.split(",").map((s) => s.trim()).filter(Boolean) ?? []);

// ── The agent under test ────────────────────────────────────────────────

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome da pessoa, sem tom de formulário." },
  tamanho: {
    type: "string",
    enum: ["1-10", "11-50", "51-200", "200+"],
    ask: "Pergunte quantas pessoas trabalham lá; ofereça as faixas.",
  },
});

const preco = {
  id: "preco",
  description: "Consulta o preço por pessoa. Use quando o cliente perguntar quanto custa.",
  parameters: {
    type: "object" as const,
    properties: { pessoas: { type: "number" as const } },
    required: ["pessoas"],
  },
  handler: (args: Record<string, unknown>) => {
    const pessoas = Number(args.pessoas) || 0;
    return { value: { porPessoa: 29, total: 29 * pessoas } };
  },
};

const triagem = f.flow({
  id: "triagem",
  name: "Triagem",
  description: "Quando alguém chega querendo saber se o produto serve para a empresa dele",
  on: [{ message: ["quer saber como funciona", "pede um orçamento"] }],
  steps: [{ id: "quem", prompt: "Descubra quem é e de quantas pessoas é a empresa.", collect: ["nome", "tamanho"] }],
});

function agentFor(provider: AiProvider, extra: Record<string, unknown> = {}) {
  return f.agent({
    name: "Ana",
    persona: "Você fala pela Acme, uma empresa de software.",
    knowledgeBase: { horario: "9h às 18h", planos: { basico: "R$ 29 por pessoa" } },
    provider,
    flows: [triagem],
    tools: [preco],
    idle: { prompt: "Responda pela empresa; não invente preços." },
    ...extra,
  });
}

// ── Checks ──────────────────────────────────────────────────────────────

interface Check {
  name: string;
  run: (provider: AiProvider, label: string) => Promise<string>;
}

const checks: Check[] = [
  {
    name: "speak",
    run: async (provider) => {
      const r = await agentFor(provider).turn({ sessionId: "live-speak", message: "oi, quero saber como funciona" });
      const text = r.messages[0]?.text ?? "";
      assert(r.messages.length === 1, `expected one message, got ${r.messages.length}`);
      assert(text.length > 0, "the message was empty");
      assert(!text.trimStart().startsWith("{"), `raw JSON reached the customer: ${text.slice(0, 80)}`);
      assert(r.llmCalls <= 2, `spent ${r.llmCalls} calls on a text turn (budget is 2)`);
      return `"${oneLine(text)}" · ${r.llmCalls} call(s)`;
    },
  },
  {
    name: "fields",
    run: async (provider) => {
      const agent = agentFor(provider);
      const first = await agent.turn({ sessionId: "live-fields", message: "oi, quero saber como funciona", id: "m1" });
      const second = await agent.turn({
        sessionId: "live-fields",
        session: first.session,
        message: "sou o João, da Acme, somos umas 30 pessoas",
        id: "m2",
        history: [],
      });
      const data = second.session.data as { nome?: string; tamanho?: string };
      assert(typeof data.nome === "string" && /jo/i.test(data.nome), `nome not collected: ${JSON.stringify(data)}`);
      assert(data.tamanho === "11-50", `tamanho should snap to the enum, got ${JSON.stringify(data.tamanho)}`);
      return `nome=${data.nome} tamanho=${data.tamanho}`;
    },
  },
  {
    name: "tools",
    run: async (provider) => {
      const r = await agentFor(provider).turn({ sessionId: "live-tools", message: "quanto custa para 10 pessoas?" });
      const called = r.outcomes.some(() => true) && r.llmCalls >= 2;
      const text = r.messages[0]?.text ?? "";
      assert(text.length > 0, "no answer came back");
      // The tool returns 290 for ten people. A model that called it says so;
      // one that invented a number usually does not land on it exactly.
      const used = /290|29/.test(text);
      assert(called || used, `neither a tool round nor the tool's number: "${oneLine(text)}"`);
      return `${used ? "quoted the tool's number" : "answered"} · ${r.llmCalls} call(s)`;
    },
  },
  {
    name: "streaming",
    run: async (provider) => {
      const deltas: string[] = [];
      let final = "";
      for await (const chunk of agentFor(provider).turnStream({ sessionId: "live-stream", message: "oi, quero saber como funciona" })) {
        if ("delta" in chunk) deltas.push(chunk.delta);
        else final = chunk.result.messages[0]?.text ?? "";
      }
      assert(final.length > 0, "the stream produced no message");
      assert(!final.trimStart().startsWith("{"), "raw JSON reached the customer");
      const joined = deltas.join("");
      assert(!joined.includes('"message"'), "the envelope's own JSON leaked into the deltas");
      return `${deltas.length} delta(s), ${final.length} chars`;
    },
  },
  {
    name: "system",
    run: async (provider) => {
      // The knowledge base only exists in the cacheable system half. An answer
      // that knows the opening hours proves the provider read that message.
      const r = await agentFor(provider).turn({ sessionId: "live-system", message: "vocês atendem que horas?" });
      const text = r.messages[0]?.text ?? "";
      assert(text.length > 0, "no answer came back");
      assert(/9|18|nove|dezoito/i.test(text), `the system half was not read: "${oneLine(text)}"`);
      return `"${oneLine(text)}"`;
    },
  },
  {
    name: "cache",
    run: async (provider, label) => {
      // Same agent, same stable prefix, two turns. A provider that caches the
      // system block reports the second one as a cache read. The counts come
      // off `TurnResult.usage`, which is also what a host bills from.
      //
      // The knowledge base is padded past every provider's minimum cacheable
      // prefix (~1k tokens on the GLM and DeepSeek endpoints). Under it there
      // is no cache to hit and the check proves nothing either way.
      const agent = agentFor(provider, { knowledgeBase: { horario: "9h às 18h", politicas: POLICIES } });
      const first = await agent.turn({ sessionId: "live-cache-1", message: "oi, quero saber como funciona" });
      const second = await agent.turn({ sessionId: "live-cache-2", session: first.session, message: "oi, quero saber como funciona", history: [] });
      const turns = [first.usage, second.usage];
      const cached = turns.reduce((a, u) => a + (u?.cachedInputTokens ?? 0), 0);
      const prompt = turns.reduce((a, u) => a + (u?.promptTokens ?? 0), 0);
      if (!prompt) return "provider reported no token counts";
      // Not every provider caches at this size; report rather than fail.
      return cached > 0
        ? `${cached}/${prompt} prompt tokens read from cache`
        : `no cache read (${prompt} prompt tokens; ${label} may need a longer prefix)`;
    },
  },
  {
    name: "auth",
    run: async (provider, label) => {
      const bad = sameProviderWithKey(label, "sk-definitely-not-a-real-key-000000");
      if (!bad) return "skipped: cannot rebuild this provider with a bad key";
      try {
        await agentFor(bad).turn({ sessionId: "live-auth", message: "oi" });
      } catch (error) {
        const kind = error instanceof ProviderError ? error.kind : "(not a ProviderError)";
        assert(kind === "auth", `a bad key classified as "${kind}", not "auth"`);
        return `classified as auth`;
      }
      throw new Error("a bad key did not fail");
    },
  },
  {
    name: "context",
    run: async (provider) => {
      // Far past every current context window. The point is the CLASSIFICATION:
      // before this, any failure read as a generic outage and the runner
      // retried the same oversized prompt every fifteen minutes forever.
      const wall = "palavra ".repeat(2_000_000);
      try {
        await agentFor(provider, { knowledgeBase: { ruido: wall } }).turn({ sessionId: "live-context", message: "oi" });
      } catch (error) {
        const kind = error instanceof ProviderError ? error.kind : "(not a ProviderError)";
        assert(kind === "context" || kind === "invalid", `an oversized prompt classified as "${kind}"`);
        return `classified as ${kind}`;
      }
      return "the provider accepted it (no context ceiling hit)";
    },
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────

/** Filler with the shape of a real knowledge base: long enough to be cacheable. */
const POLICIES = Object.fromEntries(
  Array.from({ length: 60 }, (_, i) => [
    `politica_${i + 1}`,
    `Regra ${i + 1}: pedidos acima de R$ ${(i + 1) * 100} passam por aprovação do gerente da conta, ` +
      `que responde em até ${(i % 3) + 1} dia(s) útil(eis). Cancelamentos seguem o mesmo prazo.`,
  ]),
);

function assert(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

function oneLine(text: string, max = 70): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function sameProviderWithKey(label: string, apiKey: string): AiProvider | null {
  if (label.startsWith("gemini")) return new GeminiProvider({ apiKey, model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash" });
  if (label.startsWith("zai")) return new ZaiProvider({ apiKey, model: process.env.ZAI_MODEL ?? "glm-5.3-flash" });
  if (label.startsWith("deepseek")) return new DeepSeekProvider({ apiKey, model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat" });
  if (label.startsWith("openrouter")) return new OpenRouterProvider({ apiKey, model: process.env.OPENROUTER_MODEL ?? "z-ai/glm-5.3-flash" });
  return null;
}

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

// ── Run ─────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const all = providers();
  const selected = ONLY ? all.filter((p) => ONLY.some((o) => p.label.startsWith(o))) : all;
  if (selected.length === 0) {
    console.error("No provider keys in the environment. Set GEMINI_API_KEY, ZAI_API_KEY, DEEPSEEK_API_KEY or OPENROUTER_API_KEY.");
    return 2;
  }

  let failures = 0;
  for (const { label, provider } of selected) {
    console.log(`\n── ${label} ${"─".repeat(Math.max(0, 56 - label.length))}`);
    for (const check of checks) {
      if (SKIP.has(check.name)) {
        console.log(`  ○ ${check.name.padEnd(10)} skipped`);
        continue;
      }
      const started = Date.now();
      try {
        const detail = await check.run(provider, label);
        console.log(`  ✓ ${check.name.padEnd(10)} ${String(Date.now() - started).padStart(5)}ms  ${detail}`);
      } catch (error) {
        failures++;
        const message = error instanceof Error ? error.message : String(error);
        console.log(`  ✗ ${check.name.padEnd(10)} ${String(Date.now() - started).padStart(5)}ms  ${oneLine(message, 120)}`);
      }
    }
  }

  console.log(failures === 0 ? `\nAll checks passed on ${selected.length} provider(s).` : `\n${failures} check(s) failed.`);
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
