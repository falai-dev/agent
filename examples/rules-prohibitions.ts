/**
 * Rules & Prohibitions Example
 * Updated for v2 architecture with session state management
 *
 * Demonstrates how to use rules and prohibitions to control agent behavior
 * in different conversation routes (e.g., WhatsApp bot with different styles)
 */

import {
  Agent,
  createMessageEvent,
  EventSource,
  createSession,
} from "../src/index";
import { AnthropicProvider } from "../src/providers";

// Initialize AI provider
const ai = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY || "your-api-key-here",
  model: "claude-sonnet-4-5",
});

// Create WhatsApp support bot with different styles per route
const agent = new Agent({
  name: "SupportBot",
  description: "Customer support assistant for WhatsApp",
  ai,
});

// Route 1: Quick Support - Short, direct messages
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

// Route 2: Sales Consultation - Conversational, engaging
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

// Route 3: Technical Support - Detailed, step-by-step
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

// Route 4: Emergency Support - Calm, reassuring, action-oriented
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

// Route 5: General Chat - Friendly, casual, helpful
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

// Demonstration function
async function demonstrateRulesAndProhibitions() {
  console.log("\n=== Rules & Prohibitions Demo ===\n");

  // Example 1: Quick Support - Should be short and direct
  console.log("1️⃣  Quick Support Route (short, direct)");
  const history1 = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "What are your business hours?"
    ),
  ];

  // Initialize session state for multi-turn conversation
  let session = createSession();

  const response1 = await agent.respond({ history: history1, session });
  console.log(`Route: ${response1.session?.currentRoute?.title}`);
  console.log(`Response: ${response1.message}`);
  console.log(`Expected: Short, direct, max 1 emoji\n`);

  // Update session with progress
  session = response1.session!;

  // Example 2: Sales Consultation - Should be engaging and value-focused
  console.log("2️⃣  Sales Consultation Route (conversational, value-first)");
  const history2 = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Bob",
      "I'm interested in your premium plan"
    ),
  ];

  const response2 = await agent.respond({ history: history2, session });
  console.log(`Route: ${response2.session?.currentRoute?.title}`);
  console.log(`Response: ${response2.message}`);
  console.log(`Expected: Ask about needs, show value before price\n`);

  // Update session again
  session = response2.session!;

  // Example 3: Technical Support - Should be detailed and step-by-step
  console.log("3️⃣  Technical Support Route (detailed, step-by-step)");
  const history3 = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Charlie",
      "My app keeps crashing when I try to login"
    ),
  ];

  const response3 = await agent.respond({ history: history3, session });
  console.log(`Route: ${response3.session?.currentRoute?.title}`);
  console.log(`Response: ${response3.message}`);
  console.log(`Expected: Clear steps, simple language, patient\n`);

  // Update session again
  session = response3.session!;

  // Example 4: Emergency Support - Should be calm and action-oriented
  console.log("4️⃣  Emergency Support Route (urgent, professional)");
  const history4 = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Diana",
      "This is urgent! My payment failed and I need access NOW!"
    ),
  ];

  const response4 = await agent.respond({ history: history4, session });
  console.log(`Route: ${response4.session?.currentRoute?.title}`);
  console.log(`Response: ${response4.message}`);
  console.log(`Expected: Acknowledge urgency, no emojis, concrete steps\n`);

  // Update session again
  session = response4.session!;

  // Example 5: General Chat - Should be friendly and casual
  console.log("5️⃣  General Chat Route (friendly, casual)");
  const history5 = [
    createMessageEvent(EventSource.CUSTOMER, "Eve", "Hey! How's it going?"),
  ];

  const response5 = await agent.respond({ history: history5, session });
  console.log(`Route: ${response5.session?.currentRoute?.title}`);
  console.log(`Response: ${response5.message}`);
  console.log(`Expected: Friendly, emojis, mirrors customer tone\n`);
}

// Inspect route configurations
console.log("\n📋 Route Configurations:\n");
for (const route of agent.getRoutes()) {
  console.log(`\n🛤️  ${route.title}`);

  const rules = route.getRules();
  if (rules.length > 0) {
    console.log(`  ✅ Rules (${rules.length}):`);
    rules.forEach((rule, i) => console.log(`     ${i + 1}. ${rule}`));
  }

  const prohibitions = route.getProhibitions();
  if (prohibitions.length > 0) {
    console.log(`  ❌ Prohibitions (${prohibitions.length}):`);
    prohibitions.forEach((prohibition, i) =>
      console.log(`     ${i + 1}. ${prohibition}`)
    );
  }
}

// Benefits explanation
console.log(`
\n💡 Benefits of Rules & Prohibitions:

1️⃣  **Context-Specific Behavior**
   - Each route can have completely different communication styles
   - WhatsApp support: short messages
   - Sales: engaging, story-driven
   - Technical: detailed, step-by-step

2️⃣  **Brand Consistency**
   - Rules ensure the agent always follows brand guidelines
   - Prohibitions prevent off-brand behavior
   - Different routes for different contexts

3️⃣  **User Experience**
   - Emergency route: professional, no emojis
   - General chat: friendly, casual
   - Technical support: patient, thorough

4️⃣  **Automatic Enforcement**
   - Rules are applied in the AI prompt automatically
   - No manual checking needed
   - Consistent behavior across all conversations

5️⃣  **Easy to Update**
   - Change rules without changing code
   - A/B test different communication styles
   - Iterate based on customer feedback
`);

// Run demonstration
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateRulesAndProhibitions().catch(console.error);
}

export { agent };
