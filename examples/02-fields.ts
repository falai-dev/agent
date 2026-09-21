/**
 * Fields: authored once, asked in any order, each with its own wording.
 *
 * Teaches: `ask`, `enum`, `extract: 'asked'`, `maxAsks`, a step's own `ask`,
 * confirmation as a collected boolean behind an `if`, `clearOnStart`.
 * Read next: docs/concepts/collection.md
 *
 * Run: GEMINI_API_KEY=... bun run examples/02-fields.ts
 */

import { falai, GeminiProvider, type DataOf } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome de um jeito leve, sem tom de formulário." },
  empresa: { type: "string", ask: "Pergunte de qual empresa a pessoa fala." },
  tamanho: {
    type: "string",
    enum: ["1-10", "11-50", "51-200", "200+"],
    ask: "Pergunte quantas pessoas trabalham lá e ofereça as faixas.",
  },
  orcamento: { type: "number", ask: "Pergunte a faixa de investimento, dizendo que é só para orientar." },
  // Booleans are harvested only from the reply to the step that asks them,
  // so a stray "sim" elsewhere never confirms anything.
  confirmado: { type: "boolean", ask: "Resuma em uma frase o que anotou e pergunte se está tudo certo." },
});

type Data = DataOf<typeof f>;
// Data = { nome: string; empresa: string; tamanho: '1-10' | '11-50' | '51-200' | '200+'; orcamento: number; confirmado: boolean }

const triagem = f.flow({
  id: "triagem",
  name: "Triagem",
  description: "Quando alguém chega querendo saber se o produto serve para a empresa dele.",
  on: [{ message: ["quer saber como funciona", "pede um orçamento"], repeat: "always" }],
  // A second run starts clean; the other fields stay known.
  clearOnStart: ["confirmado"],
  steps: [
    // A step ends when its fields are known. If the first message already
    // said "sou a Ana, da Acme", this step is skipped without a model call.
    { id: "quem", prompt: "Descubra quem é e de onde fala.", collect: ["nome", "empresa"] },
    // No prompt: the fields' own `ask` texts drive the question.
    { id: "porte", collect: ["tamanho"] },
    // Step wording wins over the field's; give up after two tries.
    {
      id: "grana",
      collect: ["orcamento"],
      ask: { orcamento: "Pergunte quanto {{data.empresa}} pensa em investir por mês; aceite 'não sei'." },
      maxAsks: 2,
    },
    { id: "confirma", collect: ["confirmado"] },
    // A "no" clears the confirmation and starts over from the first step.
    { id: "ok", if: { equals: { confirmado: true } }, else: { step: "quem", clear: ["confirmado"] } },
    { id: "tchau", prompt: "Agradeça e diga que um vendedor continua daqui." },
  ],
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [triagem],
});

// Two turns. Fields land in whatever order the customer gives them.
const first = await agent.turn({ sessionId: "demo", message: "Oi, sou a Ana da Acme, quero um orçamento" });
console.log(first.messages[0]?.text);

const second = await agent.turn({
  sessionId: "demo",
  session: first.session,
  message: "Somos 30 pessoas",
});
console.log(second.messages[0]?.text);

const data: Partial<Data> = second.session.data;
console.log(data); // { nome: 'Ana', empresa: 'Acme', tamanho: '11-50' }
