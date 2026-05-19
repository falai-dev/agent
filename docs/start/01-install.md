---
title: "Install"
description: "Install @falai/agent, set up your environment, and grab a provider key."
type: tutorial
order: 1
---

# Install

Before you write a flow or define a schema, you need `@falai/agent` in your project and a provider key in your environment. This page handles both. By the end you will have a verified provider instance and a clean slate for the agent you build on the next page.

## Prerequisites

- Node.js **18+** or Bun **1.0+**
- A package manager (Bun, npm, pnpm, or yarn)
- An API key from at least one provider — see [Provider keys](#provider-keys) below

## Install the package

```bash
bun add @falai/agent
```

Or, with another package manager:

```bash
npm install @falai/agent
# or
pnpm add @falai/agent
# or
yarn add @falai/agent
```

The package ships ESM and CJS entry points and bundles its TypeScript types — there is no `@types/*` companion to install.

## Set up your environment

Create a `.env` file at the root of your project. You only need a key for the provider you plan to use.

```bash
# .env
GEMINI_API_KEY=your-gemini-key
OPENAI_API_KEY=your-openai-key
ANTHROPIC_API_KEY=your-anthropic-key
OPENROUTER_API_KEY=your-openrouter-key   # optional broker
```

Load the file before your agent code runs. Bun reads `.env` automatically; with Node, pass `--env-file=.env` (Node 20+) or use your tool of choice.

## Provider keys

Pick one provider to start. The tutorial uses Gemini by default because it has the fastest free tier; swap to another vendor by changing one constructor in [Your first agent](./02-first-agent.md).

- **Google Gemini** — [Gemini Studio](https://aistudio.google.com/apikey) (`GEMINI_API_KEY`)
- **OpenAI** — [OpenAI Platform](https://platform.openai.com/api-keys) (`OPENAI_API_KEY`)
- **Anthropic** — [Anthropic Console](https://console.anthropic.com/settings/keys) (`ANTHROPIC_API_KEY`)
- **OpenRouter** *(optional broker for many vendors behind one key)* — [OpenRouter](https://openrouter.ai/keys) (`OPENROUTER_API_KEY`)

Any one of these is enough to finish the tutorial. The [Providers reference](../reference/providers.md) covers options like `backupModels` and per-vendor `config`.

## Verify the install

Drop this into `src/check.ts` and run it. If it prints `Provider ready`, you are set.

```typescript
import { GeminiProvider } from "@falai/agent";

const provider = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "models/gemini-2.5-pro",
});

console.log("Provider ready:", provider.constructor.name);
```

```bash
bun run src/check.ts
# Provider ready: GeminiProvider
```

**Next:** [Your first agent](./02-first-agent.md)
