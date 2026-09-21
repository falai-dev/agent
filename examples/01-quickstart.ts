/**
 * Quickstart: one field, one flow, one turn.
 *
 * Run: GEMINI_API_KEY=... bun run examples/01-quickstart.ts
 */

import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome da pessoa, sem tom de formulário." },
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [
    f.flow({
      id: "boas-vindas",
      name: "Boas-vindas",
      on: [{ message: [] }],
      steps: [
        { id: "nome", collect: ["nome"] },
        { id: "ajuda", prompt: "Agradeça pelo nome e pergunte como pode ajudar." },
      ],
    }),
  ],
});

const r = await agent.turn({ sessionId: "demo", message: "oi" });
console.log(r.messages[0]?.text);
