/**
 * Streaming: the reply arrives token by token, the result at the end.
 *
 * Teaches: `agent.turnStream`, `{ delta }` chunks, the `{ done, result }`
 * chunk, `llmCalls`.
 * Read next: docs/guides/streaming.md
 *
 * Run: GEMINI_API_KEY=... bun run examples/07-streaming.ts
 */

import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
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

// Only the AI's reply streams. `say` messages and everything else come whole,
// in the final chunk's `result`, exactly as `turn()` would return them.
for await (const chunk of agent.turnStream({ sessionId: "demo", message: "oi, sou o Rui" })) {
  if ("delta" in chunk) {
    process.stdout.write(chunk.delta);
    continue;
  }
  process.stdout.write("\n");
  console.log(`mensagens: ${chunk.result.messages.length}, chamadas ao modelo: ${chunk.result.llmCalls}`);
  console.log(chunk.result.session.data); // { nome: 'Rui' }
}
