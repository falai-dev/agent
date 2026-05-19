---
title: "Collect data"
description: "Use the agent's schema to extract city, dates, and party size from one message — without asking three questions in a row."
type: tutorial
order: 3
---

# Collect data

One schema, three steps, one completion gate. The engine extracts what it can in a single pass, skips steps whose data is already present, and finishes the flow the moment every required field lands. This page shows the pattern end to end — from a user who types everything in one sentence to a user who answers one field at a time.

In [Your first agent](./02-first-agent.md), the agent answered a single message. This page extends that scaffold into something more useful: a hotel-booking agent that lifts structured fields out of a user's message and skips any question it already has the answer to.

You will define a schema, write three steps that each `collect` one field, gate the confirmation step with `requires`, bypass already-answered steps with `skip`, and seal the flow with `requiredFields`. By the end of the page, a single sentence — *"I want a hotel in Lisbon for two people next Friday"* — will populate every field in one turn and land the agent on the confirmation step before the user types again.

Keep the file from the previous tutorial open. Everything here is one continuous edit.

## Define the schema

The schema is the single source of truth for everything the agent collects across the whole conversation. It lives at the agent level, not the flow level, and every `collect` site below references keys defined here.

Add a `BookingData` type and pass a matching `schema` to `createAgent`:

```typescript
import { createAgent, GeminiProvider } from "@falai/agent";

interface BookingData {
  city: string;
  checkIn: string;
  guests: number;
}

const agent = createAgent<unknown, BookingData>({
  name: "BookingBot",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  schema: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: "Destination city the user wants to stay in.",
      },
      checkIn: {
        type: "string",
        description: "Check-in date as ISO yyyy-mm-dd.",
      },
      guests: {
        type: "integer",
        description: "Number of people staying. Defaults to 1 if not stated.",
      },
    },
  },
  flows: [/* added in the next section */],
});
```

The `description` strings inside `properties` are not decoration. The provider sees them on every turn and uses them to extract fields from the user's message. Spend a sentence on each one — it pays back at extraction time. Especially for ambiguous fields (a date format, an ID prefix, a unit), the description is the only place you can tell the extractor what "valid" looks like.

Two type parameters flow through `createAgent`: `TContext` (ambient data, ignored here) and `TData` (the booking shape). They propagate to every step's `collect` array and every tool handler. Misspell a key in `collect: ["citi"]` and the type checker objects at the call site.

## Collect one field per step

A `Step` declares which schema fields it is responsible for through its `collect` array. The engine reads that array on every turn — if any listed key is already populated in `session.data`, the step is skipped automatically. That is the core of pre-extraction: the engine will not ask a question whose answer it already has.

Add a `Booking` flow with three collection steps:

```typescript
flows: [
  {
    title: "Booking",
    description: "Book a hotel by collecting destination, date, and party size.",
    when: "the user wants to book a hotel",
    requiredFields: ["city", "checkIn", "guests"],
    steps: [
      {
        id: "ask_city",
        prompt: "Find out which city the user wants to stay in.",
        collect: ["city"],
      },
      {
        id: "ask_check_in",
        prompt: "Find out which date the user wants to check in.",
        collect: ["checkIn"],
        requires: ["city"],
      },
      {
        id: "ask_guests",
        prompt: "Find out how many people are travelling.",
        collect: ["guests"],
        requires: ["city", "checkIn"],
        skip: ({ data }) => typeof data.guests === "number",
      },
      {
        id: "confirm",
        prompt:
          "Read back the city, check-in date, and guest count. Ask the user to confirm.",
        requires: ["city", "checkIn", "guests"],
      },
    ],
  },
],
```

Three things deserve a closer look.

`collect` is an instruction to the extractor, not a question gate. When the user message contains a city, the extractor populates `city` and the engine moves past `ask_city` whether or not that step ran a prompt. The step exists for the case where the field is still missing on entry — it asks the question that produces the value.

`requires` is the prerequisite gate. The engine refuses to enter a step until every key listed in `requires` is present in `session.data`. Without `requires: ["city"]` on `ask_check_in`, a user who messages "next Friday" first would stall the flow — the engine would extract `checkIn`, see no `city`, and have nothing to do.

`skip` is the bypass. It accepts a code predicate that runs on every turn; when it returns `true`, the step is skipped regardless of whether its `collect` set is satisfied. The example above demonstrates the pattern but is functionally redundant — the `collect: ["guests"]` already covers the same case. Use `skip` when the bypass condition is *not* about a `collect` field — for example, "skip the verification step if the user is already authenticated."

## Gate completion with `requiredFields`

The flow's `requiredFields` is the contract for "this flow is done." When every field listed there is present in `session.data`, the engine fires the flow's completion path on the next turn boundary. Pre-extraction, sequential steps, and one-shot collection all converge on the same gate.

The `confirm` step in the snippet above does not collect anything — it only requires. Its job is to read the booking back to the user before the flow completes. This pattern is common: collection steps populate the schema, a final non-collecting step closes the loop.

```typescript
{
  id: "confirm",
  prompt:
    "Read back the city, check-in date, and guest count. Ask the user to confirm.",
  requires: ["city", "checkIn", "guests"],
},
```

The flow ends here implicitly. There is no terminus marker, no end-of-flow constant, no return value — the last step in `steps[]` is the implicit terminus. When `requiredFields` is satisfied, the flow completes; if a flow with no `requiredFields` reaches its last step, the same path runs.

A field that the flow can use but does not need belongs in `optionalFields` instead. It is descriptive only — never gates completion, but appears alongside `requiredFields` in re-entry resets if the flow is reentrant. For this tutorial, every field is required, so `optionalFields` stays empty.

## The data fields at a glance

Three field-related properties show up in the snippets above. They look similar but answer different questions:

| Property | Lives on | Question it answers | Cost |
|----------|----------|---------------------|------|
| `schema.properties` | Agent | What can be extracted at all? | One extraction call per turn. |
| `step.collect` | Step | Which fields does this step want this turn? | Free — engine inspects `session.data`. |
| `step.requires` | Step | Which fields must already be present to enter this step? | Free — engine inspects `session.data`. |
| `step.skip` | Step | Should this step be bypassed regardless of `collect`? | Free — code predicate. |
| `flow.requiredFields` | Flow | When is the flow done? | Free — engine inspects `session.data`. |

The pattern is consistent: the schema describes the universe of possible data, every other property describes a slice over that universe. Pre-extraction is what stitches them together — without it, every step would have to ask its question regardless of what the user already said.

## Watch pre-extraction work

Run the file with a single message that contains all three fields:

```typescript
const session = { id: "demo-session" };

const response = await agent.respond(
  "I want a hotel in Lisbon for two people next Friday.",
  session,
);

console.log(response.message);
console.log(response.data);
console.log(response.currentStep?.id);
```

The output is roughly:

```
> Just to confirm: a hotel in Lisbon, checking in 2025-11-21, for 2 guests. Shall I book it?
{ city: "Lisbon", checkIn: "2025-11-21", guests: 2 }
confirm
```

Three things happened in one turn:

1. **Pre-extraction ran first.** Before any step prompt or LLM step call, the extractor read the user message against the agent's schema and populated `city`, `checkIn`, and `guests` in `session.data`. The check-in date was normalized to the ISO format the schema described.
2. **The first three steps skipped.** `ask_city`, `ask_check_in`, and `ask_guests` each have a `collect` array whose every key was already present after extraction. The engine skipped them in order without calling the LLM for any of them.
3. **The engine landed on `confirm`.** Its `requires` were satisfied, its `collect` was empty, and its prompt asked for confirmation. That is the only LLM step that ran for the turn.

Try a message with one missing field:

```typescript
await agent.respond("Book me a hotel in Lisbon next Friday.", session);
```

The extractor populates `city` and `checkIn`. `ask_city` and `ask_check_in` both skip — their `collect` keys are present. `ask_guests` does *not* skip — `guests` is undefined — so the engine enters it and the assistant asks how many people are travelling.

Try the inverse: a message with only one field.

```typescript
await agent.respond("I'd like to go to Lisbon.", session);
```

The extractor populates `city` only. `ask_city` skips, `ask_check_in` enters next (its `requires: ["city"]` is satisfied), and the assistant asks for the check-in date. Three turns later, the same `confirm` step runs.

The same flow handles every shape of message — one field at a time, three at once, two-then-one — because `collect`, `requires`, and `skip` describe what the step needs rather than how many turns the conversation will take.

### Routing skip

One detail worth knowing: when pre-extraction populates a field listed in the *current* step's `collect`, the engine treats that as confirmation that the user is answering this step rather than asking for something new. It skips the flow router entirely for that turn and stays in the active flow. The tradeoff is small — if the user both answers the step and signals new intent in the same message, the new intent is recovered on the next turn. In return, a user who is mid-form does not get bounced into a different flow because their answer happened to share a few words with another flow's `when`.

## Why this works

`TData` is agent-level. The schema is declared once and every `collect` site references it; the extractor sees the full schema on every turn and lifts whatever it can in a single pass. Steps then act as filters over `session.data`: a step whose `collect` set is satisfied vanishes from the conversation, and a step whose `requires` set is missing refuses to run.

The split between AI work and code work is visible at every site:

- **Extraction** (AI): given a user message and the schema, populate as many fields as possible.
- **Skip / require / completion** (code): given the populated `session.data`, decide whether each step runs, whether the flow continues, and whether `requiredFields` is satisfied.

The framework spends one extraction call per turn on the AI side and pure data inspection on the code side. There is no separate "form mode" or "completion check" — the same step shape works whether the user fills the form one field at a time or pastes a full request in a single sentence.

## Recap

You added four things to the agent from the previous tutorial:

- A typed `BookingData` schema, declared at the agent level.
- Three collection steps, each with its own `collect` array.
- A `requires` chain to gate the order in which steps may enter.
- A `requiredFields` list on the flow to define completion.

The pre-extraction property is what makes the rest worthwhile. A user who knows what they want types one sentence; a user who needs guidance types one field at a time; the same flow handles both because every step describes its own contract over `session.data` rather than its position in a conversation.

Two things are missing from the booking flow before it can do anything in the real world. There is no booking action — `confirm` ends with the user agreeing, and nothing happens. There is also no way to redirect when something goes wrong (the user is not eligible, the inventory is empty, the date is in the past). The next page adds tools to handle both.

**Next:** [Add tools](./04-add-tools.md)
