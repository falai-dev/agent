/**
 * Rules & Prohibitions Example
 * Updated for v2 architecture with session step management
 *
 * Demonstrates how to use rules and prohibitions to control agent behavior
 * in different conversation routes (e.g., WhatsApp bot with different styles)
 */

import {
  Agent,
  type Event,
  type MessageEventData,
  EventKind,
  EventSource,
  END_ROUTE,
} from "../src";
import { OpenAIProvider } from "../src/providers/OpenAIProvider";

/**
 * Configuration for the AI provider
 */
const ai = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY || "your-api-key-here",
  model: "gpt-5",
});

/**
 * Create a new agent instance with predefined routes and rules/prohibitions.
 */
const agent = new Agent({
  name: "CustomerServiceAgent",
  description:
    "A versatile customer service agent that adapts its behavior based on the conversation's context.",
  goal: "Provide excellent customer service by following route-specific rules and prohibitions.",
  ai,
  debug: true,
});

/**
 * Add routes to the agent.
 */
agent.createRoute({
  title: "Quick Support",
  description: "Fast answers for common questions",
  conditions: ["User has a simple question", "User wants quick help"],
  rules: [
    "Keep messages extremely short (1-2 lines maximum)",
    "Use bullet points for lists",
    "Maximum 1 emoji per message 👍",
    "Be direct and to the point",
  ],
  prohibitions: [
    "Never send long paragraphs",
    "Do not over-explain",
    "Never use more than 2 emojis",
    "Do not ask follow-up questions unless necessary",
  ],
});

agent.createRoute({
  title: "Sales Consultation",
  description: "Help customer discover needs and present solutions",
  conditions: [
    "User is interested in buying",
    "User wants product information",
  ],
  rules: [
    "Ask open-ended questions to discover needs",
    "Use storytelling when presenting solutions",
    "Emoji to reinforce positive emotions 😊✨",
    "Present value before mentioning price",
    "Make customer feel special and understood",
  ],
  prohibitions: [
    "Never talk about price before showing value",
    "Do not pressure or push",
    "Avoid technical jargon",
    "Never send more than 2 messages without waiting for response",
    "Do not make promises you cannot keep",
  ],
});

agent.createRoute({
  title: "Technical Support",
  description: "Help with technical issues and troubleshooting",
  conditions: ["User has technical problem", "User needs step-by-step help"],
  rules: [
    "Provide clear, numbered steps",
    "Use simple language for technical concepts",
    "Confirm understanding after each major step",
    "Offer screenshots or visual aids when helpful",
    "Be patient and thorough",
  ],
  prohibitions: [
    "Never skip steps or assume knowledge",
    "Do not use excessive technical terms without explanation",
    "Never blame the user for the issue",
    "Do not rush through explanations",
  ],
});

// Add a stepful feedback flow to the Technical Support route
const techSupportRoute = agent
  .getRoutes()
  .find((r) => r.title === "Technical Support")!;
techSupportRoute.initialStep
  .nextStep({
    instructions: "Provide step-by-step technical assistance.",
  })
  .nextStep({
    instructions: "Ask for a rating of the support provided (1-5).",
    collect: ["feedbackRating"],
  })
  .nextStep({
    instructions: "Ask for any additional comments.",
    collect: ["feedbackComments"],
  })
  .nextStep({
    instructions: "Thank the user for their feedback.",
  })
  .nextStep({ step: END_ROUTE });

agent.createRoute({
  title: "Emergency Support",
  description: "Handle urgent customer issues",
  conditions: ["Customer is frustrated", "Urgent issue", "Service down"],
  rules: [
    "Acknowledge the urgency immediately",
    "Express empathy and understanding",
    "Provide concrete next steps",
    "Set clear expectations on resolution time",
    "Keep customer updated",
  ],
  prohibitions: [
    "Never downplay the customer's concern",
    "Do not use emojis (keep it professional)",
    'Never say "calm down" or similar dismissive phrases',
    "Do not transfer without explaining why",
    "Never make excuses or blame others",
  ],
});

agent.createRoute({
  title: "General Chat",
  description: "Casual conversation and general questions",
  conditions: ["User is just chatting", "Greeting", "General question"],
  rules: [
    "Be friendly and conversational",
    "Use emojis naturally 😊",
    "Mirror the customer's tone and energy",
    "Keep it light and positive",
  ],
  prohibitions: [
    "Do not be overly formal",
    "Never ignore the customer's mood",
    "Do not push products unless asked",
  ],
});

/**
 * Demonstration function to show how the agent responds to different scenarios.
 */
async function demonstrateRulesAndProhibitions() {
  const agent = new Agent({
    name: "CustomerServiceAgent",
    description:
      "A versatile customer service agent that adapts its behavior based on the conversation's context.",
    goal: "Provide excellent customer service by following route-specific rules and prohibitions.",
    ai,
    debug: true,
  });

  // Add domains
  agent.createRoute({
    title: "Quick Support",
    description: "Fast answers for common questions",
    conditions: ["User has a simple question", "User wants quick help"],
    rules: [
      "Keep messages extremely short (1-2 lines maximum)",
      "Use bullet points for lists",
      "Maximum 1 emoji per message 👍",
      "Be direct and to the point",
    ],
    prohibitions: [
      "Never send long paragraphs",
      "Do not over-explain",
      "Never use more than 2 emojis",
      "Do not ask follow-up questions unless necessary",
    ],
  });

  agent.createRoute({
    title: "Sales Consultation",
    description: "Help customer discover needs and present solutions",
    conditions: [
      "User is interested in buying",
      "User wants product information",
    ],
    rules: [
      "Ask open-ended questions to discover needs",
      "Use storytelling when presenting solutions",
      "Emoji to reinforce positive emotions 😊✨",
      "Present value before mentioning price",
      "Make customer feel special and understood",
    ],
    prohibitions: [
      "Never talk about price before showing value",
      "Do not pressure or push",
      "Avoid technical jargon",
      "Never send more than 2 messages without waiting for response",
      "Do not make promises you cannot keep",
    ],
  });

  agent.createRoute({
    title: "Technical Support",
    description: "Help with technical issues and troubleshooting",
    conditions: ["User has technical problem", "User needs step-by-step help"],
    rules: [
      "Provide clear, numbered steps",
      "Use simple language for technical concepts",
      "Confirm understanding after each major step",
      "Offer screenshots or visual aids when helpful",
      "Be patient and thorough",
    ],
    prohibitions: [
      "Never skip steps or assume knowledge",
      "Do not use excessive technical terms without explanation",
      "Never blame the user for the issue",
      "Do not rush through explanations",
    ],
  });

  // Add a stepful feedback flow to the Technical Support route
  const techSupportRoute = agent
    .getRoutes()
    .find((r) => r.title === "Technical Support")!;
  techSupportRoute.initialStep
    .nextStep({
      instructions: "Provide step-by-step technical assistance.",
    })
    .nextStep({
      instructions: "Ask for a rating of the support provided (1-5).",
      collect: ["feedbackRating"],
    })
    .nextStep({
      instructions: "Ask for any additional comments.",
      collect: ["feedbackComments"],
    })
    .nextStep({
      instructions: "Thank the user for their feedback.",
    })
    .nextStep({ step: END_ROUTE });

  agent.createRoute({
    title: "Emergency Support",
    description: "Handle urgent customer issues",
    conditions: ["Customer is frustrated", "Urgent issue", "Service down"],
    rules: [
      "Acknowledge the urgency immediately",
      "Express empathy and understanding",
      "Provide concrete next steps",
      "Set clear expectations on resolution time",
      "Keep customer updated",
    ],
    prohibitions: [
      "Never downplay the customer's concern",
      "Do not use emojis (keep it professional)",
      'Never say "calm down" or similar dismissive phrases',
      "Do not transfer without explaining why",
      "Never make excuses or blame others",
    ],
  });

  agent.createRoute({
    title: "General Chat",
    description: "Casual conversation and general questions",
    conditions: ["User is just chatting", "Greeting", "General question"],
    rules: [
      "Be friendly and conversational",
      "Use emojis naturally 😊",
      "Mirror the customer's tone and energy",
      "Keep it light and positive",
    ],
    prohibitions: [
      "Do not be overly formal",
      "Never ignore the customer's mood",
      "Do not push products unless asked",
    ],
  });

  console.info("\n=== Rules & Prohibitions Demo ===\n");

  // --- Quick Support ---
  console.info("1️⃣  Quick Support Route (short, direct)");
  const quickSupportHistory: Event[] = [
    {
      kind: EventKind.MESSAGE,
      source: EventSource.CUSTOMER,
      data: {
        participant: { display_name: "User" },
        message: "How do I reset my password?",
      },
    },
  ];
  const response1 = await agent.respond({ history: quickSupportHistory });
  console.info(`Route: ${response1.session?.currentRoute?.title}`);
  console.info(`Response: ${response1.message}`);
  console.info(`Expected: Short, direct, max 1 emoji\n`);

  // --- Sales Consultation ---
  console.info("2️⃣  Sales Consultation Route (conversational, value-first)");
  const salesHistory: Event[] = [
    {
      kind: EventKind.MESSAGE,
      source: EventSource.CUSTOMER,
      data: {
        message: "How much does your premium plan cost?",
        participant: { display_name: "User" },
      },
    },
  ];
  const response2 = await agent.respond({ history: salesHistory });
  console.info(`Route: ${response2.session?.currentRoute?.title}`);
  console.info(`Response: ${response2.message}`);
  console.info(`Expected: Ask about needs, show value before price\n`);

  // --- Technical Support ---
  console.info("3️⃣  Technical Support Route (detailed, step-by-step)");
  const techSupportHistory: Event[] = [
    {
      kind: EventKind.MESSAGE,
      source: EventSource.CUSTOMER,
      data: {
        message: "My new headphones won't connect to Bluetooth.",
        participant: { display_name: "User" },
      },
    },
  ];
  const response3 = await agent.respond({ history: techSupportHistory });
  console.info(`Route: ${response3.session?.currentRoute?.title}`);
  console.info(`Response: ${response3.message}`);
  console.info(`Expected: Clear steps, simple language, patient\n`);
  if (response3.isRouteComplete) {
    console.info("\n✅ Technical support feedback collected!");
  }

  // --- Emergency Support ---
  console.info("4️⃣  Emergency Support Route (urgent, professional)");
  const emergencyHistory: Event[] = [
    {
      kind: EventKind.MESSAGE,
      source: EventSource.CUSTOMER,
      data: {
        message: "My account has been compromised!",
        participant: { display_name: "User" },
      },
    },
  ];
  const response4 = await agent.respond({ history: emergencyHistory });
  console.info(`Route: ${response4.session?.currentRoute?.title}`);
  console.info(`Response: ${response4.message}`);
  console.info(`Expected: Acknowledge urgency, no emojis, concrete steps\n`);

  // --- General Chat ---
  console.info("5️⃣  General Chat Route (friendly, casual)");
  const generalHistory: Event[] = [
    {
      kind: EventKind.MESSAGE,
      source: EventSource.CUSTOMER,
      data: {
        message: "What's the weather like today?",
        participant: { display_name: "User" },
      },
    } as Event<MessageEventData>,
  ];
  const response5 = await agent.respond({ history: generalHistory });
  console.info(`Route: ${response5.session?.currentRoute?.title}`);
  console.info(`Response: ${response5.message}`);
  console.info(`Expected: Friendly, emojis, mirrors customer tone\n`);
}

/**
 * Inspect route configurations.
 */
console.info("\n📋 Route Configurations:\n");
agent.getRoutes().forEach((route) => {
  console.info(`\n🛤️  ${route.title}`);
  const rules = route.getRules();
  const prohibitions = route.getProhibitions();

  if (rules.length > 0) {
    console.info(`  ✅ Rules (${rules.length}):`);
    rules.forEach((rule, i) => console.info(`     ${i + 1}. ${rule}`));
  }

  if (prohibitions.length > 0) {
    console.info(`  ❌ Prohibitions (${prohibitions.length}):`);
    prohibitions.forEach((prohibition, i) =>
      console.info(`     ${i + 1}. ${prohibition}`)
    );
  }
});

/**
 * Benefits explanation.
 */
console.info(`
💡 This demo shows how rules and prohibitions, combined with routing,
   allow a single agent to handle diverse scenarios with tailored,
   context-appropriate behavior.
`);

/**
 * Mock function to log support feedback.
 * @param data - The feedback data.
 */
async function logSupportFeedback(
  _context: undefined,
  _history: Event[],
  _session: undefined,
  data: { feedbackRating: number; feedbackComments: string }
) {
  console.info("\n" + "=".repeat(60));
  console.info("📝 Logging Support Feedback...");
  console.info("=".repeat(60));
  console.info("Feedback Details:", JSON.stringify(data, null, 2));
  console.info(`   - Rating: ${data.feedbackRating}`);
  console.info(`   - Comments: ${data.feedbackComments}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.info("✨ Feedback logged successfully!");
  return { success: true };
}

// Run demonstration
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateRulesAndProhibitions().catch((err) => console.error(err));
}

export { agent };
