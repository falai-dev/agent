/**
 * Tools: functions the AI may call while it speaks.
 *
 * Teaches: `Tool.handler(args, ctx)` → `{ value, data }`, `isReadOnly`,
 * `validateInput`, tools scoped to one step.
 * Read next: docs/reference/tool.md
 *
 * Run: GEMINI_API_KEY=... bun run examples/03-tools.ts
 */

import { falai, GeminiProvider, type DataOf, type Tool } from "@falai/agent";

const f = falai().fields({
  cidade: { type: "string", ask: "Pergunte em qual cidade a pessoa quer ficar." },
  entrada: { type: "string", description: "Data de entrada, AAAA-MM-DD", ask: "Pergunte a data de entrada." },
  saida: { type: "string", description: "Data de saída, AAAA-MM-DD", ask: "Pergunte a data de saída." },
  reserva: { type: "string", description: "Código da reserva" },
});

type Data = DataOf<typeof f>;

// `value` is what the model reads back. `data` is written to the session.
const disponibilidade: Tool<undefined, Data> = {
  id: "disponibilidade",
  description: "Consulta quartos livres em uma cidade entre duas datas.",
  parameters: {
    type: "object",
    properties: {
      cidade: { type: "string" },
      entrada: { type: "string" },
      saida: { type: "string" },
    },
    required: ["cidade", "entrada", "saida"],
  },
  isReadOnly: () => true,
  validateInput: (args) =>
    String(args.entrada) < String(args.saida)
      ? { valid: true }
      : { valid: false, error: "A saída precisa ser depois da entrada." },
  handler: (args) => ({
    value: { quartos: 3, precoNoite: 420, cidade: args.cidade },
  }),
};

const reservar: Tool<undefined, Data> = {
  id: "reservar",
  description: "Confirma a reserva e devolve o código.",
  parameters: {
    type: "object",
    properties: { cidade: { type: "string" }, entrada: { type: "string" }, saida: { type: "string" } },
    required: ["cidade", "entrada", "saida"],
  },
  isDestructive: () => true,
  handler: (args, ctx) => {
    const codigo = `RES-${ctx.now.getTime().toString(36).toUpperCase()}`;
    console.log("reservando", args, "→", codigo);
    // Writing `reserva` here is what lets the `confirma` step end.
    return { value: { codigo }, data: { reserva: codigo } };
  },
};

const agent = f.agent({
  name: "Concierge",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  tools: [disponibilidade, reservar],
  flows: [
    f.flow({
      id: "hospedagem",
      name: "Hospedagem",
      on: [{ message: ["quer reservar um quarto", "pergunta sobre hospedagem"] }],
      steps: [
        { id: "onde", collect: ["cidade", "entrada", "saida"] },
        // Only this step may call `disponibilidade`.
        {
          id: "oferta",
          prompt: "Consulte a disponibilidade e apresente preço e quartos livres. Pergunte se pode reservar.",
          tools: ["disponibilidade"],
        },
        // The step ends when `reserva` is known, which the tool writes.
        {
          id: "confirma",
          prompt: "Se a pessoa confirmou, reserve e informe o código.",
          collect: ["reserva"],
          tools: ["reservar"],
        },
      ],
    }),
  ],
});

const r = await agent.turn({
  sessionId: "demo",
  message: "Quero um quarto em Curitiba de 2026-10-03 a 2026-10-05",
});
console.log(r.messages[0]?.text);
console.log(`chamadas ao modelo: ${r.llmCalls}`);
