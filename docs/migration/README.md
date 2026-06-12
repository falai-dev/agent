---
title: "Migration"
description: "Migration guides for upgrading @falai/agent between major and minor versions."
type: overview
order: 99
---

# Migration

Upgrading from `2.3.x`? The v2.4 guide covers the concurrency-safety and provider-layer changes — required `AiProvider.capabilities`, normalized `ProviderError`, optimistic session locking with `SessionConflictError`, the `unknown` generic defaults, and the internals removed from the public barrel — with before/after code and per-adapter notes.

[Read the v2.3 → v2.4 migration guide](./v2-3-to-v2-4.md)

Upgrading from `1.x`? The consolidated migration guide covers every breaking change in v2 — including the Route → Flow rename, the Instruction unification, the Tool merge, and the Directive collapse — with rename tables, per-adapter schema migrations, and before/after code for each section.

[Read the v1 → v2 migration guide](./v1-to-v2.md)

Section 3 covers the Route → Flow rename in full, including per-adapter SQL/Mongo/Redis/OpenSearch migration snippets and ID-prefix guidance.
