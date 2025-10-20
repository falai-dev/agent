/**
 * Test the new branching API with IDs
 */

import { Agent } from "../src/core/Agent";
import { END_ROUTE } from "../src/constants";

// Create a test agent
const agent = new Agent<any, any>({
  name: "Test Agent",
  provider: {
    name: "Test Provider",
    generateMessage: async () => ({ message: "test" }),
    generateMessageStream: async function* () {
      yield { delta: "test", accumulated: "test", done: true };
    },
  },
  schema: {
    type: "object",
    properties: {
      account_number: { type: "string" },
      issue_description: { type: "string" },
    },
  },
});

// Test the branching API
const route = agent.createRoute({
  title: "Test Route",
  description: "Testing branching functionality",
});

console.log("Testing linear flow...");
const step1 = route.initialStep.nextStep({
  prompt: "How can I help you today?",
});

console.log("Testing branching with IDs...");
const branches = step1.branch([
  {
    name: "Customer Support",
    id: "customer_support_step",
    step: {
      prompt:
        "I understand you have a customer support question. What's your account number?",
      collect: ["account_number"],
    },
  },
  {
    name: "billing inquiry",
    id: "billing_inquiry_step",
    step: {
      prompt:
        "I see you're having a billing issue. Can you describe the problem?",
      collect: ["issue_description"],
    },
  },
  {
    name: "general",
    step: {
      prompt: "I'd be happy to help with your general inquiry.",
    },
  },
]);

console.log("Available branches:", Object.keys(branches));

// Test accessing branches with different key types
console.log("Building Customer Support branch...");
branches["Customer Support"]
  .nextStep({
    prompt: "What specific support issue are you facing?",
  })
  .nextStep({ step: END_ROUTE });

console.log("Building billing inquiry branch...");
branches["billing inquiry"]
  .nextStep({
    prompt: "When did this billing issue occur?",
  })
  .nextStep({ step: END_ROUTE });

console.log("Building general branch...");
branches.general
  .nextStep({
    prompt: "Please tell me more about your question.",
  })
  .nextStep({ step: END_ROUTE });

console.log("Route structure:", route.describe());
console.log("Test completed successfully! ✅");
