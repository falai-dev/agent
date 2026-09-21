/**
 * Flows as JSON: store them in a database, let an editor draw them, let a
 * model write them. The JSON form is the same object the code form is.
 *
 * Teaches: `FlowSpec`, `f.fromSpec`, `toSpec`, `validateFlow`,
 * `flowSpecSchema` as the response schema of a generation call.
 * Read next: docs/reference/flow-spec.md
 *
 * Run: GEMINI_API_KEY=... bun run examples/09-flows-from-json.ts
 */

import {
  falai,
  FlowConfigurationError,
  flowSpecSchema,
  GeminiProvider,
  toSpec,
  validateFlow,
  type FlowSpec,
} from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
  empresa: { type: "string", ask: "Pergunte a empresa." },
});

// Everything a stored flow may name is registered once, by name.
const registries = {
  fields: f.fields,
  actions: {
    notify: f.action({
      parameters: { recipient: { type: "string" }, message: { type: "string" } },
      run: (params) => {
        console.log(`[notify] ${params.recipient}: ${params.message}`);
        return { ok: true };
      },
    }),
    add_tags: f.action({
      parameters: { tags: { type: "array", items: { type: "string" } } },
      run: (params) => {
        console.log("[add_tags]", params.tags);
        return { ok: true };
      },
    }),
  },
};

// ─── A rule typed in a chat, stored as a row ─────────────────────────────────
// Flat steps with a `kind`; predicates in JSON; no functions anywhere.

const concorrente: FlowSpec = {
  id: "concorrente",
  name: "Lead falou de concorrente",
  on: [{ mention: ["o lead cita ou compara com um concorrente"], extract: { trecho: { type: "string" } }, repeat: "once" }],
  steps: [
    { id: "tag", kind: "do", do: "add_tags", with: { tags: ["concorrente"] } },
    { id: "avisa", kind: "do", do: "notify", with: { recipient: "owner", message: '{{data.nome}} falou de concorrente: "{{input.trecho}}"' } },
  ],
};

// Validate on save: the error names the unknown field, action, event, condition or step.
const { warnings } = validateFlow(concorrente, registries);
console.log("avisos:", warnings);

try {
  validateFlow({ ...concorrente, steps: [{ id: "x", kind: "do", do: "send_email", with: {} }] }, registries);
} catch (error) {
  if (error instanceof FlowConfigurationError) console.log(error.message);
}

// ─── The same flow written in TypeScript is the same object ─────────────────

const triagem = f.flow({
  id: "triagem",
  name: "Triagem",
  on: [{ message: ["quer um orçamento"] }],
  steps: [
    { id: "quem", prompt: "Descubra quem é.", collect: ["nome", "empresa"] },
    { id: "avisa", do: "notify", with: { recipient: "owner", message: "Lead: {{data.nome}} ({{data.empresa}})" } },
  ],
});
console.log(JSON.stringify(toSpec(triagem).steps[0])); // {"id":"quem","kind":"collect","prompt":"Descubra quem é.","collect":["nome","empresa"]}

// ─── Letting a model write one ───────────────────────────────────────────────
// `flowSpecSchema` is closed and lists this agent's fields, actions, events and
// conditions, so the model can only write a flow that validates.

const provider = new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" });
const generated = await provider.generateMessage<undefined, FlowSpec>({
  prompt: "Write a flow, as JSON, for this request: 'quando o lead pedir para falar com uma pessoa, avise o dono e marque a tag humano'. Write the texts in Brazilian Portuguese.",
  history: [],
  context: undefined,
  parameters: { jsonSchema: flowSpecSchema(registries), schemaName: "flow" },
});
// The schema shapes the answer; `validateFlow` is what proves it. Never trust the JSON before that.
const spec = generated.structured;
if (!spec) throw new Error("The model returned no JSON.");
validateFlow(spec, registries);

// Rows load into the agent like any other flow.
const agent = f.agent({
  name: "Ana",
  provider,
  ...registries,
  flows: [triagem, f.fromSpec(concorrente), f.fromSpec(spec)],
});
console.log(agent.options.flows?.map((flow) => flow.id)); // [ 'triagem', 'concorrente', '<generated id>' ]
