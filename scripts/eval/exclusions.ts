/**
 * Does a `!` phrase change the model's answer, or only the prompt?
 *
 * prospectar's `pediu_humano` signal hands the conversation to a person. Its
 * four exclusions exist because a lead saying "pode sim" to an offer of a
 * meeting mentions a person without asking for one. This replays the real
 * phrase list against real providers, once with the exclusions honoured and
 * once with the `!` stripped — which is what v4 did before they were read.
 *
 * Run: bun run scripts/eval/exclusions.ts
 */

import { GeminiProvider } from "../../src/providers/GeminiProvider.js";
import { ZaiProvider } from "../../src/providers/ZaiProvider.js";
import { Understand } from "../../src/core/Understand.js";
import type { UnderstandRequest } from "../../src/core/contracts.js";
import type { AgentOptions } from "../../src/types/agent.js";
import type { AiProvider } from "../../src/types/ai.js";
import type { FieldDefs, Flow } from "../../src/types/flow.js";

type Data = Record<string, unknown>;
const fields: FieldDefs = { nome: { type: "string", ask: "Pergunte o nome." } };

const PHRASES = [
  "O lead pede explicitamente para falar com um humano, pessoa real ou atendente",
  "O lead pede para falar com o vendedor, o consultor, o dono ou alguém da empresa (ex.: falar com um vendedor, me passa pro comercial)",
  "O lead diz que não quer falar com robô, bot ou IA",
  "O lead pede para ser transferido para alguém",
  "O lead pergunta se tem alguém de verdade disponível",
  "!O lead apenas concorda em agendar, marcar reunião/horário ou seguir o próximo passo proposto pelo agente (ex.: pode sim, pode marcar, fechado)",
  "!O lead responde de forma afirmativa a uma oferta que não seja explicitamente falar com um atendente humano",
  "!Menção casual a outras pessoas sem pedir atendimento humano (ex.: meu sócio resolve isso)",
  "!Frustração ou impaciência sem um pedido explícito de falar com um humano",
];

function flowWith(phrases: string[]): Flow<undefined, Data> {
  return {
    id: "pediu_humano",
    name: "Pediu atendimento humano",
    description: "O lead pede para falar com uma pessoa: vendedor, consultor ou alguém da empresa.",
    on: [{ mention: phrases }],
    steps: [{ id: "avisa", say: "Claro, já chamei alguém da equipe." }],
  };
}

/** message, what a human says it should answer. */
const CASES: Array<{ text: string; want: boolean; why: string }> = [
  { text: "quero falar com um vendedor", want: true, why: "asks for a person outright" },
  { text: "me passa pro comercial", want: true, why: "asks for a person outright" },
  { text: "tem alguém de verdade aí?", want: true, why: "asks whether a person is there" },
  { text: "não quero falar com robô", want: true, why: "rejects the bot" },
  { text: "pode sim", want: false, why: "agrees to the meeting just offered" },
  { text: "pode marcar pra quinta", want: false, why: "agrees to the meeting just offered" },
  { text: "fechado, pode ser", want: false, why: "agrees to the meeting just offered" },
  { text: "meu sócio resolve isso comigo depois", want: false, why: "mentions a person, asks for nobody" },
  { text: "demorou pra responder hein", want: false, why: "impatience, no request" },
  { text: "e qual o preço?", want: false, why: "unrelated" },
];

const HISTORY = [{ role: "assistant" as const, content: "Consigo marcar uma conversa com um consultor. Pode ser quinta às 10h?" }];

async function ask(provider: AiProvider, flow: Flow<undefined, Data>, text: string): Promise<boolean | null> {
  const options: AgentOptions<undefined, Data> = { name: "Ana", provider, fields, flows: [flow] };
  const req: UnderstandRequest<undefined, Data> = {
    text,
    history: HISTORY,
    context: undefined,
    data: {},
    messageFlows: [],
    mentionFlows: [flow],
    branches: [],
    fields: {},
  };
  try {
    const r = await new Understand(options).run(req);
    const value = r.mentions["pediu_humano"];
    return typeof value === "boolean" ? value : null;
  } catch (err) {
    console.log(`    ! ${(err as Error).message.slice(0, 110)}`);
    return null;
  }
}

async function score(label: string, provider: AiProvider): Promise<void> {
  console.log(`\n═══ ${label} ═══`);
  for (const [mode, phrases] of [
    ["with exclusions   ", PHRASES],
    ["stripped (old v4) ", PHRASES.map((p) => (p.startsWith("!") ? p.slice(1) : p))],
  ] as const) {
    const flow = flowWith([...phrases]);
    let right = 0;
    const wrong: string[] = [];
    for (const c of CASES) {
      const got = await ask(provider, flow, c.text);
      if (got === c.want) right++;
      else wrong.push(`"${c.text}" → ${got} (quer ${c.want}: ${c.why})`);
    }
    console.log(`  ${mode} ${right}/${CASES.length}`);
    for (const w of wrong) console.log(`      ✗ ${w}`);
  }
}

const providers: Array<[string, AiProvider]> = [];
if (process.env.GEMINI_API_KEY) {
  providers.push(["Gemini 2.5 Flash", new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY, model: "gemini-2.5-flash" })]);
}
if (process.env.ZAI_API_KEY) {
  providers.push(["Z.ai GLM (production primary)", new ZaiProvider({ apiKey: process.env.ZAI_API_KEY, model: "glm-4.6" })]);
}
if (providers.length === 0) throw new Error("No provider key in the environment.");

for (const [label, provider] of providers) await score(label, provider);
