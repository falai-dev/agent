/**
 * Response prompt: already-known fields
 *
 * Pre-extraction (and earlier turns) put values in session.data before the
 * response prompt is built. The routing prompt always showed them; the
 * response prompt did not, so the model followed a step guideline like
 * "ask which device" for a device the user had already named. The prompt
 * must mark known fields and, when every FOCUS field of the step is known,
 * declare the step's questions done.
 */

import { describe, test, expect } from "bun:test";
import { Agent } from "../src/index.js";
import { ResponseEngine } from "../src/core/ResponseEngine.js";
import { MockProviderFactory } from "./mock-provider.js";

interface SalesData {
  device: string;
  budget: string;
}

function buildAgent() {
  const agent = new Agent<unknown, SalesData>({
    name: "Seller",
    provider: MockProviderFactory.basic(),
    schema: {
      type: "object",
      properties: {
        device: { type: "string", description: "Device the lead wants" },
        budget: { type: "string", description: "How much the lead can spend" },
      },
    },
  });
  const flow = agent.createFlow({
    id: "sales",
    title: "Sales",
    description: "Sell a phone",
    when: ["lead wants a phone"],
    steps: [
      { id: "ask-device", prompt: "Greet and ask which device they want.", collect: ["device"] },
      { id: "ask-budget", prompt: "Ask the budget.", collect: ["budget"] },
    ],
  });
  return { agent, flow };
}

async function buildPrompt(data: Partial<SalesData>) {
  const { agent, flow } = buildAgent();
  const { prompt } = await new ResponseEngine<unknown, SalesData>().buildResponsePrompt({
    flow,
    currentStep: flow.getStep("ask-device")!,
    rules: [],
    prohibitions: [],
    directives: undefined,
    history: [],
    agentSchema: agent.schema,
    session: { id: "s1", data },
  });
  return prompt;
}

describe("ResponseEngine: already-known fields", () => {
  test("nothing known → no marker, step not declared satisfied", async () => {
    const prompt = await buildPrompt({});
    expect(prompt).toContain("device (string): Device the lead wants ← FOCUS FOR THIS STEP");
    expect(prompt).not.toContain("← ALREADY KNOWN:");
    expect(prompt).not.toContain("this step's questions are done");
  });

  test("a FOCUS field already in session data is marked and the step is satisfied", async () => {
    const prompt = await buildPrompt({ device: "iPhone 15 Pro Max" });
    expect(prompt).toContain('← FOCUS FOR THIS STEP ← ALREADY KNOWN: "iPhone 15 Pro Max"');
    expect(prompt).toContain("NEVER ask the user for it again");
    expect(prompt).toContain("this step's questions are done");
  });

  test("empty string does not count as known", async () => {
    const prompt = await buildPrompt({ device: "" });
    expect(prompt).not.toContain("← ALREADY KNOWN:");
  });
});
