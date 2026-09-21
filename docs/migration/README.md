---
title: "Migration"
description: "Migration guides for upgrading @falai/agent between major and minor versions."
type: overview
order: 99
---

# Migration

Upgrading from `3.x`? v4 is a clean break: flows, automations and signals become one Flow with triggers (`message`, `mention`, `silence`, `event`, manual `start`) and five step kinds; `agent.turn()` replaces `respond()` and returns the messages to send and the timers to set; fields carry their own `ask` and land in any order; `Store` replaces the persistence adapters; the session blob migrates once with `migrateSession`. The guide has before/after code for every change, a removed → replacement table, and the `rg` line that finds every call site.

[Read the v3 → v4 migration guide](./v3-to-v4.md)

Upgrading from `2.6.x`? The v2.7 guide covers the consumer-fit release surface — `message`/`allowedFlows` turn parameters, `endedFlows` and `metadata.tokensUsed`, provider `client` injection, and the exported `restoreSession` — plus the behavior changes to know: the default 400-message history bound, finalize-before-persist ordering, soft-failing tools, bare typed-error propagation, and session load failures that now throw.

[Read the v2.6 → v2.7 migration guide](./v2-6-to-v2-7.md)

Upgrading from `2.3.x`? The v2.4 guide covers the concurrency-safety and provider-layer changes — required `AiProvider.capabilities`, normalized `ProviderError`, optimistic session locking with `SessionConflictError`, the `unknown` generic defaults, and the internals removed from the public barrel — with before/after code and per-adapter notes.

[Read the v2.3 → v2.4 migration guide](./v2-3-to-v2-4.md)

Upgrading from `1.x`? The consolidated migration guide covers every breaking change in v2 — including the Route → Flow rename, the Instruction unification, the Tool merge, and the Directive collapse — with rename tables, per-adapter schema migrations, and before/after code for each section.

[Read the v1 → v2 migration guide](./v1-to-v2.md)

Section 3 covers the Route → Flow rename in full, including per-adapter SQL/Mongo/Redis/OpenSearch migration snippets and ID-prefix guidance.
