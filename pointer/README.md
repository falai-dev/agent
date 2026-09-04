# falai

This package is an alias. The framework is published as **[`@falai/agent`](https://www.npmjs.com/package/@falai/agent)** — a conversational state engine for TypeScript where the AI understands, but the code is in control.

Install that one:

```bash
npm install @falai/agent
```

```ts
import { createAgent } from "@falai/agent";
```

`falai` re-exports `@falai/agent` unchanged and depends on `^3.0.0` of it, so `import { createAgent } from "falai"` works and resolves to the same module instance — but every version, doc and example lives under the scoped name. Use `@falai/agent`.

- Docs — https://falai.dev
- Source — https://github.com/falai-dev/agent

Not affiliated with [fal.ai](https://fal.ai), whose packages are published under [`@fal-ai`](https://www.npmjs.com/org/fal-ai).
