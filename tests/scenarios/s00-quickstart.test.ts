/**
 * The README's first example, examples/01-quickstart.ts, with the mock
 * provider: one field, one catch-all flow, one turn, one message, one call.
 */
import { expect, test } from "bun:test";

import { falai } from "../../src/index.js";
import { mockProvider } from "../mock-provider.js";

test("quickstart: agent.turn({ message: 'oi' }) returns one message after one call", async () => {
  const f = falai().fields({
    nome: { type: "string", ask: "Pergunte o nome da pessoa, sem tom de formulário." },
  });
  const provider = mockProvider({ speak: [{ message: "Oi! Eu sou a Ana. Como você se chama?", nome: null }] });
  const agent = f.agent({
    name: "Ana",
    provider,
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
  // A catch-all is the only flow and nothing is extractable from "oi" ahead of the ask: no understand call.
  expect(provider.calls.map((c) => c.schemaName)).toEqual(["speak"]);
  expect(r.llmCalls).toBe(1);
  expect(r.messages.map((m) => m.text)).toEqual(["Oi! Eu sou a Ana. Como você se chama?"]);
  expect(r.session.runs[0]).toMatchObject({ flowId: "boas-vindas", stepId: "nome", status: "asking" });
  expect(r.changed).toBe(true);
});
