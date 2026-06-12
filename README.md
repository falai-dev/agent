<div align="center">

# @falai/agent

**Typed conversations where code stays in charge.**

Define flows, steps, and tools in TypeScript; the framework calls the LLM only for the parts that need language — routing, extraction, and generation.

[![npm](https://img.shields.io/npm/v/@falai/agent.svg)](https://www.npmjs.com/package/@falai/agent)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue.svg)](https://www.typescriptlang.org/)

</div>

> The AI understands. The code is in control.

```typescript
import { createAgent, GeminiProvider } from "@falai/agent";

const agent = createAgent({
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  schema: { type: "object", properties: { name: { type: "string" } } },
  flows: [{
    title: "Greet",
    requiredFields: ["name"],
    steps: [{ id: "ask_name", prompt: "What's your name?", collect: ["name"] }],
  }],
});

const response = await agent.respond("Hi, I'm Alice");
console.log(response.message);
```

## Primitives

### Agent

**Bind schema to provider.**

The top-level object. Owns the schema, the provider, the flows, the tools, and the session. One agent serves many conversations.

### Flow

**Collect until done.**

A goal made of ordered steps. Declares which schema fields it needs; the engine completes the flow when every required field has been collected.

### Tool

**Run code, redirect flow.**

A typed function the AI can call. Receives a `ToolContext` with session data, can dispatch directives to redirect the conversation, and returns a typed result.

## Where to go next

- **Build your first agent** → [docs/start/01-install.md](./docs/start/01-install.md)
- **Explore the docs** → [docs/](./docs/README.md)
- **Examples** → [examples/](./examples/)
- **Upgrading** → [docs/migration/](./docs/migration/README.md) (v2.3 → v2.4, v1 → v2)

## Install

```bash
bun add @falai/agent
# or
npm install @falai/agent
# or
pnpm add @falai/agent
```

Requires Node 18+ or Bun 1.0+. Set a provider API key in your environment (for example `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, or `DEEPSEEK_API_KEY`).

## License

MIT © 2025

<div align="center">

[falai.dev](https://falai.dev) · [GitHub](https://github.com/falai-dev/agent) · [Issues](https://github.com/falai-dev/agent/issues)

</div>
