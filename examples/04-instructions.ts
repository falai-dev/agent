/**
 * Instructions: behavioural rules the AI follows while they apply.
 *
 * Teaches: `kind` must/never/should, `when` (judged by the AI), `if` (judged
 * by code, free), agent-, flow- and step-level instructions, `persona`,
 * `goal`, `knowledgeBase`.
 * Read next: docs/reference/instruction.md
 *
 * Run: GEMINI_API_KEY=... bun run examples/04-instructions.ts
 */

import { falai, GeminiProvider } from "@falai/agent";

interface Ctx {
  plano: "gratis" | "pro";
  horaLocal: number;
}

const f = falai<Ctx>().fields({
  duvida: { type: "string", ask: "Pergunte qual é a dúvida, em uma frase." },
});

const agent = f.agent({
  name: "Bia",
  persona: "Você fala pela Loja Azul, de forma direta e simpática.",
  goal: "Tirar dúvidas sobre planos e cobrança sem inventar preços.",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  knowledgeBase: {
    planos: { gratis: "até 3 projetos", pro: "R$ 49/mês, projetos ilimitados" },
    suporte: "seg a sex, 9h às 18h",
  },
  instructions: [
    { kind: "never", prompt: "Nunca invente preços ou prazos que não estejam na base de conhecimento." },
    // Judged by the AI from the conversation.
    { kind: "must", when: "a pessoa está irritada", prompt: "Reconheça o problema antes de explicar qualquer coisa." },
    // Judged by code from the context; costs nothing.
    {
      kind: "should",
      if: ({ context }) => context.horaLocal >= 18 || context.horaLocal < 9,
      prompt: "Avise que o suporte humano volta às 9h.",
    },
    {
      kind: "should",
      if: ({ context }) => context.plano === "gratis",
      prompt: "Se fizer sentido, mencione o que o plano Pro acrescenta, sem insistir.",
    },
  ],
  flows: [
    f.flow({
      id: "duvidas",
      name: "Dúvidas",
      on: [{ message: [] }],
      // Applies to every step of this flow.
      instructions: [{ kind: "should", prompt: "Responda em até três frases." }],
      steps: [
        { id: "qual", collect: ["duvida"] },
        {
          id: "resposta",
          prompt: "Responda a dúvida com a base de conhecimento.",
          // Applies to this step only.
          instructions: [{ kind: "must", prompt: "Termine perguntando se ficou claro." }],
        },
      ],
    }),
  ],
});

const r = await agent.turn({
  sessionId: "demo",
  context: { plano: "gratis", horaLocal: 21 },
  message: "quanto custa o plano pro?",
});
console.log(r.messages[0]?.text);
