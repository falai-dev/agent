---
title: "Install the package"
description: "Put @falai/agent in a project, set one provider key and run the first example."
type: tutorial
order: 1
---

# Install the package

This tutorial builds Ana, the WhatsApp assistant of a small Brazilian company. Ana answers people who write in: she finds out who is writing, from which company and how big it is, confirms what she noted, and hands the customer to a seller. Five pages, one agent. Each page adds to the one before.

This page puts the package in a project and runs the first example.

## What you need

- Node 22.12 or newer, or Bun 1.0 or newer. The minimum is 22.12, not 22: the CommonJS build calls `require()` on an ESM-only dependency, and Node learned to do that in 22.12.
- One API key from a model provider. The tutorial uses Google Gemini. Any provider in the table below works the same way.

## Add it to your project

```bash
bun add @falai/agent
```

With npm or pnpm:

```bash
npm install @falai/agent
# or
pnpm add @falai/agent
```

The package ships an ESM build, a CommonJS build and its own TypeScript types. There is nothing else to install.

## Set a provider key

A provider is the class that talks to the model. Every one takes `{ apiKey, model }`:

```ts
import { GeminiProvider } from "@falai/agent";

const provider = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY ?? "",
  model: "gemini-2.5-flash",
});
```

Swap the class to change providers; the rest of your code does not move.

| Model provider | Class |
|---|---|
| Google Gemini | `GeminiProvider` |
| OpenAI | `OpenAIProvider` |
| Anthropic | `AnthropicProvider` |
| OpenRouter | `OpenRouterProvider` |
| DeepSeek | `DeepSeekProvider` |
| Z.ai | `ZaiProvider` |

Every constructor throws right away when `apiKey` is empty, so a missing key fails at startup, not on the customer's first message. Put the key in a `.env` file at the project root:

```bash
# .env
GEMINI_API_KEY=your-key
```

Bun reads `.env` on its own. With Node, start with `node --env-file=.env`. The examples read `GEMINI_API_KEY`; the variable name is otherwise yours to pick. [Providers](../reference/providers.md) lists every class and its options.

## Run the first example

The repository's examples are the code this tutorial reads. Clone it, install, run:

```bash
git clone https://github.com/falai-dev/agent.git
cd agent
bun install
GEMINI_API_KEY=your-key bun run examples/01-quickstart.ts
```

Ana says hello and asks your name. That was one turn and one model call. The next page reads that file line by line.

The other examples, in order:

| File | Teaches |
|---|---|
| `02-fields.ts` | fields with their own `ask`, data landing in any order, a confirmation |
| `03-tools.ts` | tools the model may call while it speaks |
| `04-instructions.ts` | rules at agent, flow and step level |
| `05-branches.ts` | forks judged while a step is asking |
| `06-triggers-and-waits.ts` | silence and event triggers, timers, wakes |
| `07-streaming.ts` | `turnStream` |
| `08-store-and-migration.ts` | a store, the save loop, moving a 3.x session |
| `09-flows-from-json.ts` | flows stored as JSON |

Bun runs TypeScript directly. Under Node, compile with `tsc` first or use the TypeScript runner you already have.

Next: [Your first agent](./02-first-agent.md).
