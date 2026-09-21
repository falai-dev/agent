/**
 * Branches: leaving a step early, by the AI or by code.
 *
 * Teaches: `branches[]` with `when` (AI) and `if` (code), `then` as a step
 * id, `'end'` or `{ flow }`, `onEnd: 'stay'`, a handoff flow with `say` + `do`.
 * Read next: docs/concepts/pipeline.md
 *
 * Run: GEMINI_API_KEY=... bun run examples/05-branches.ts
 */

import { falai, GeminiProvider } from "@falai/agent";

interface Ctx {
  atendentesOnline: number;
}

const f = falai<Ctx>().fields({
  pedido: { type: "string", ask: "Pergunte o número do pedido." },
  problema: { type: "string", ask: "Pergunte o que aconteceu com o pedido." },
});

const agent = f.agent({
  name: "Léo",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  actions: {
    transferir: f.action({
      parameters: { fila: { type: "string" } },
      run: (params, ctx) => {
        console.log(`transferindo ${ctx.run.id} para a fila ${params.fila}`);
        return { ok: true, detail: `enviado para ${params.fila}` };
      },
    }),
  },
  flows: [
    f.flow({
      id: "suporte",
      name: "Suporte a pedidos",
      on: [{ message: ["problema com um pedido", "pedido atrasado ou errado"] }],
      steps: [
        {
          id: "dados",
          collect: ["pedido", "problema"],
          branches: [
            // The AI judges this while the step is asking.
            { when: "a pessoa pede para falar com um humano", then: { flow: "humano" } },
            // Code judges this; it costs nothing.
            { if: ({ context }) => context.atendentesOnline === 0, then: "sem-humanos" },
          ],
        },
        { id: "resolve", prompt: "Explique o próximo passo para o pedido {{data.pedido}}.", then: "end" },
        {
          id: "sem-humanos",
          say: "Nossa equipe está fora agora. Deixe os dados que retornamos assim que alguém entrar.",
          then: "dados",
        },
      ],
      // After the last step the run stays on it, so follow-up questions land here.
      onEnd: "stay",
    }),
    f.flow({
      id: "humano",
      name: "Passar para um humano",
      // No `on`: only reached by `then: { flow: 'humano' }` or `turn({ start })`.
      steps: [
        { id: "aviso", say: "Claro, vou chamar alguém da equipe. Um minuto." },
        { id: "fila", do: "transferir", with: { fila: "suporte" } },
      ],
    }),
  ],
});

const r = await agent.turn({
  sessionId: "demo",
  context: { atendentesOnline: 2 },
  message: "meu pedido 4411 veio errado, quero falar com uma pessoa",
});
for (const m of r.messages) console.log(`[${m.kind}] ${m.text}`);
console.log(r.ended.map((run) => `${run.flowId} → ${run.reason}`)); // [ 'suporte → flow' ]
