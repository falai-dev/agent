<div align="center">

# @falai/agent

**Typed conversations where code stays in charge.**

Define flows, steps and tools in TypeScript; the framework calls the AI only where language is needed: to understand what the customer wrote and to write the reply.

[![npm](https://img.shields.io/npm/v/@falai/agent.svg)](https://www.npmjs.com/package/@falai/agent)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue.svg)](https://www.typescriptlang.org/)

</div>

```ts fragment
const r = await agent.turn({ sessionId: "demo", message: "oi" });
console.log(r.messages[0]?.text); // the AI asks for a name, something like "Oi! Como posso te chamar?"
```

The `agent` behind that call, in full:

```ts
import { falai, GeminiProvider } from "@falai/agent";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("Set GEMINI_API_KEY before running this example.");

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome da pessoa, sem tom de formulário." },
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey, model: "gemini-2.5-flash" }),
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
```

## The model

- A flow is a trigger plus an ordered list of steps; a flow that has started is a run.
- A step is one of five things: the AI talks (`prompt` / `collect`), a fixed text goes out (`say`), your code runs (`do`), the run waits (`wait`), or the code forks (`if`).
- Fields live on the agent, each with its own `ask`. The customer can give them in any order, and a step whose fields are already known is skipped.
- One `agent.turn()` takes every kind of input: a customer message, a timer, an event from your system, or a start you call by hand.
- It returns the messages to send, the timers to set and one outcome line per step. The framework never sends, never sleeps and never saves. You save the session, then send the messages and set the timers.
- A text turn costs at most two model calls (understand, then speak) plus one per tool round, and one more when `compaction` summarizes the history. `r.llmCalls` says how many it spent.

## Where to go next

- **Build your first agent** → [docs/start/01-install.md](./docs/start/01-install.md)
- **Read the docs** → [docs/](./docs/README.md)
- **Examples** → [examples/](./examples/), nine runnable files from a quickstart to flows stored as JSON
- **Upgrading** → [docs/migration/](./docs/migration/README.md); v4 is a clean break from 3.x

## Install

```bash
bun add @falai/agent@alpha
# or
npm install @falai/agent@alpha
# or
pnpm add @falai/agent@alpha
```

4.0 is in alpha. Plain `@falai/agent`, with no tag, still installs 3.x, and the examples here will not compile against it.

Requires Node 22.12+ or Bun 1.0+. Set a provider API key in your environment (for example `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, or `DEEPSEEK_API_KEY`).

## License

MIT © 2026

<div align="center">

[falai.dev](https://falai.dev) · [GitHub](https://github.com/falai-dev/agent) · [Issues](https://github.com/falai-dev/agent/issues)

</div>
