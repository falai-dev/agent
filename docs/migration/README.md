---
title: "Migration guides"
description: "One guide per upgrade of @falai/agent, newest first."
type: overview
order: 99
---

# Migration guides

One guide per upgrade, newest first. Each has before and after code for every change.

- [v3 → v4](./v3-to-v4.md) — A clean break: a 3.x program does not compile against 4.0. Every old name has a new shape; the guide shows the before and after for each.
- [v2.6 → v2.7](./v2-6-to-v2-7.md) — The `message` and `allowedFlows` turn parameters, provider `client` injection, the exported `restoreSession`, and the behaviour changes: a 400-message history bound, finalize before persist, soft-failing tools, session load failures that throw.
- [v2.3 → v2.4](./v2-3-to-v2-4.md) — Concurrency safety: optimistic session locking with `SessionConflictError`, a normalized `ProviderError`, required `AiProvider.capabilities`, `unknown` generic defaults.
- [v1 → v2](./v1-to-v2.md) — Route → Flow, one `Instruction` type, one `Tool` type, one `Directive` type, with rename tables and per-adapter schema migrations.
