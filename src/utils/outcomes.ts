/**
 * One English sentence per outcome code.
 *
 * The framework copies the sentence onto every line it writes, so a log reads
 * on its own. `satisfies` makes the compiler reject a new code without a
 * sentence, so the two cannot drift. To show a line in another language, map
 * `outcome.code` yourself and ignore `outcome.message`.
 */

import type { StepOutcomeCode } from "../types/session.js";

export const OUTCOME_MESSAGES = {
  "no-session": "a wake arrived for a session that does not exist",
  "duplicate-input": "this input was already applied",
  "stale-wake": "no run is waiting on this wake",
  "silence-broken": "someone wrote after this silence wake was set",

  "already-claimed": "this flow already ran here",
  cooldown: "the flow's cooldown has not passed",
  "hop-limit": "the chain reached the hop limit",
  "already-running": "a run of this flow is already live here",
  "flow-gone": "the flow is no longer registered on the agent",

  "step-loop": "the run moved through 50 steps in one turn",
  "step-gone": "the step is no longer in the flow",
  "customer-replied": "the customer wrote before the wake fired",
  "premise-changed": "the flow's while condition no longer holds",
  silenced: "the host cannot speak right now",

  "already-known": "every field this step collects is known",
  "asked-fixed": "the step's fixed question went out word for word",
  "another-reply": "another run already answered this turn",
  "already-sent": "this message was already sent once",
  branch: "a branch of this step fired",
  "max-asks": "the field was asked the most times allowed",
  "inline-delay": "a short wait rides on the next message",
  "awaiting-trigger": "the trigger's delay has not passed",
  "awaiting-event": "the run is waiting for an event",
  "event-arrived": "the event was reported",
  "no-event": "the event did not arrive in time",
  replied: "the customer replied while the run waited",
  "no-reply": "the customer did not reply while the run waited",

  "action-skipped": "the action decided not to run",
  "action-failed": "the action failed",
  "action-deferred": "the action asked to run again later",

  "unknown-field": "no field by that name is declared on the agent",
  "bad-value": "the value did not fit the field's type",
  "not-in-enum": "the value is not one of the field's options",

  "provider-quota": "the provider's usage limit is spent",
  "provider-context": "the conversation outgrew the model's context window",
  "provider-auth": "the provider rejected the credentials",
  "provider-invalid": "the provider rejected the request",
  "provider-unavailable": "the model call failed or came back empty",
} as const satisfies Record<StepOutcomeCode, string>;
