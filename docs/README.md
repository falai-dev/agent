---
title: "@falai/agent docs"
description: "The docs for @falai/agent 4.0: a five-page tutorial, one guide per task, the concepts behind a turn, and one reference page per public type."
type: overview
order: 0
---

# @falai/agent docs

@falai/agent is a TypeScript library for building chat assistants. The AI understands what the customer wrote; your code decides what happens next. One `agent.turn()` takes a message, a timer, an event from your system or a manual start, and returns the messages to send and the timers to set. Your program, the host, sends and schedules them.

## Tutorial

Five pages that build one agent from install to production. Start at [Install](./start/01-install.md).

1. [Install](./start/01-install.md)
2. [Your first agent](./start/02-first-agent.md)
3. [Collect data](./start/03-collect-data.md)
4. [Add tools](./start/04-add-tools.md)
5. [Go to production](./start/05-go-to-production.md)

## Guides

One page per task. Each shows the code you write and what the framework does with it. Open [Triggers](./guides/triggers.md) first, since every flow starts with one; the rest stand alone.

- [Triggers](./guides/triggers.md) — message, mention, silence, event, manual start
- [Conditions](./guides/conditions.md) — `when` (the model) versus `if` (your code)
- [Branching](./guides/branching.md) — forks while a step is asking
- [Flow control](./guides/flow-control.md) — `then`, `else`, `onEnd`, `while`, chaining flows
- [Actions and events](./guides/actions-and-events.md) — what your code does and what it reports
- [Instructions](./guides/instructions.md) — rules the model follows at agent, flow or step level
- [Error handling](./guides/error-handling.md) — what throws, what stays put and retries on a timer, what you replay
- [Persistence](./guides/persistence.md) — `Store`, the version check on save, the seven built-in stores
- [Streaming](./guides/streaming.md) — `turnStream` and its chunks
- [Compaction](./guides/compaction.md) — trimming long histories once per turn
- [Flows from JSON](./guides/flows-from-json.md) — `FlowSpec`, `fromSpec`, `validateFlow`
- [Testing](./guides/testing.md) — a fake clock, an in-memory store, a scripted provider

## Concepts

Four pages explain the design. Start with [Architecture](./concepts/architecture.md).

- [Architecture](./concepts/architecture.md) — agent, flow, trigger, step, field, run, turn
- [Pipeline](./concepts/pipeline.md) — the eight phases of one turn and what each costs
- [Runs and waits](./concepts/runs-and-waits.md) — who is speaking (the floor), timers (wakes), keys and claims
- [Collection](./concepts/collection.md) — how fields get filled

## Reference

One page per public type, with every field, its type and its default, taken from the code. Start at [Agent](./reference/agent.md), which covers `falai()`, the agent options, `turn()` and its result.

- [Agent](./reference/agent.md) · [Flow](./reference/flow.md) · [Step](./reference/step.md) · [Trigger](./reference/trigger.md) · [Fields](./reference/fields.md) · [Branches](./reference/branches.md)
- [Actions, events, conditions](./reference/actions-events-conditions.md) · [Instruction](./reference/instruction.md) · [Tool](./reference/tool.md)
- [Session](./reference/session.md) · [Stores](./reference/stores.md) · [Flow spec](./reference/flow-spec.md) · [Outcomes](./reference/outcomes.md) · [Errors](./reference/errors.md) · [Providers](./reference/providers.md)

---

Upgrading from 3.x? v4 is a clean break: nothing old compiles. The [v3 → v4 migration guide](./migration/v3-to-v4.md) has the before and after for every change.
