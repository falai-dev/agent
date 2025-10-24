/**
 * String-Only Conditions Example
 * 
 * This example demonstrates using string-only conditions for AI context-driven routing.
 * String conditions are perfect when you want the AI to make routing decisions based
 * on natural language understanding rather than programmatic logic.
 * 
 * Key concepts:
 * - String conditions provide AI context only
 * - No programmatic evaluation - pure AI decision making
 * - Perfect for natural language routing scenarios
 * - Ideal for conversational flows where intent matters more than data
 */

import {
  Agent,
  GeminiProvider,
  type Guideline,
} from "../../src/index";

// Context for a customer service chatbot
interface CustomerContext {
  customerId: string;
  customerTier: "basic" | "premium" | "enterprise";
  previousInteractions: number;
}

// Simple data schema for customer interactions
interface CustomerData {
  issueType?: string;
  satisfactionRating?: number;
  followUpNeeded?: boolean;
}

const customerSchema = {
  type: "object",
  properties: {
    issueType: { type: "string" },
    satisfactionRating: { type: "number", minimum: 1, maximum: 5 },
    followUpNeeded: { type: "boolean" },
  },
};

// Create agent with string-only condition examples
const agent = new Agent<CustomerContext, CustomerData>({
  name: "CustomerServiceBot",
  description: "A customer service bot that uses AI context for routing decisions",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY || "demo-key",
    model: "models/gemini-2.5-flash",
  }),
  context: {
    customerId: "cust_12345",
    customerTier: "premium",
    previousInteractions: 3,
  },
  schema: customerSchema,
});

// Guidelines with string-only conditions for AI context
const guidelines: Guideline<CustomerContext>[] = [
  {
    // String-only condition - AI interprets the context
    condition: "Customer is expressing frustration or anger",
    action: "Acknowledge their feelings, apologize for the inconvenience, and escalate to a human agent if needed",
    tags: ["empathy", "escalation"],
  },
  {
    // String-only condition - AI understands satisfaction cues
    condition: "Customer seems satisfied with the resolution",
    action: "Thank them for their patience and ask if there's anything else you can help with",
    tags: ["satisfaction", "closure"],
  },
  {
    // String-only condition - AI detects urgency
    condition: "Customer indicates this is an urgent or time-sensitive issue",
    action: "Prioritize their request and provide immediate assistance or escalation",
    tags: ["urgency", "priority"],
  },
];

// Add guidelines to agent
guidelines.forEach(guideline => agent.createGuideline(guideline));

// Route 1: Billing Issues - String-only condition
agent.createRoute({
  title: "Billing Support",
  description: "Handle billing questions and payment issues",
  // String-only condition - AI interprets billing-related intent
  when: "Customer has questions about billing, payments, charges, or invoices",
  steps: [
    {
      id: "understand_billing_issue",
      description: "Understand the specific billing concern",
      prompt: "I'd be happy to help with your billing question. Can you tell me more about the specific issue you're experiencing?",
      collect: ["issueType"],
    },
    {
      id: "resolve_billing",
      description: "Provide billing assistance",
      prompt: "Let me help resolve your billing concern. Based on what you've told me, here's what I can do...",
      requires: ["issueType"],
    },
  ],
});

// Route 2: Technical Support - String-only condition
agent.createRoute({
  title: "Technical Support",
  description: "Help with technical problems and troubleshooting",
  // String-only condition - AI understands technical issues
  when: "Customer is experiencing technical difficulties, errors, or product malfunctions",
  steps: [
    {
      id: "diagnose_technical_issue",
      description: "Understand the technical problem",
      prompt: "I'm here to help with your technical issue. Can you describe what's happening and when the problem started?",
      collect: ["issueType"],
    },
    {
      id: "provide_technical_solution",
      description: "Offer technical assistance",
      prompt: "Based on your description, let me walk you through some troubleshooting steps...",
      requires: ["issueType"],
    },
  ],
});

// Route 3: Account Management - String-only condition
agent.createRoute({
  title: "Account Management",
  description: "Handle account changes, updates, and settings",
  // String-only condition - AI recognizes account-related requests
  when: "Customer wants to make changes to their account, update information, or modify settings",
  steps: [
    {
      id: "identify_account_request",
      description: "Understand what account changes are needed",
      prompt: "I can help you with your account. What changes would you like to make?",
      collect: ["issueType"],
    },
    {
      id: "process_account_changes",
      description: "Assist with account modifications",
      prompt: "I'll help you make those account changes. Let me guide you through the process...",
      requires: ["issueType"],
    },
  ],
});

// Route 4: General Inquiry - String-only condition
agent.createRoute({
  title: "General Information",
  description: "Answer general questions about products and services",
  // String-only condition - AI handles general questions
  when: "Customer has general questions about products, services, or company information",
  steps: [
    {
      id: "answer_general_question",
      description: "Provide information and answer questions",
      prompt: "I'd be happy to answer your question. Let me provide you with the information you need...",
    },
  ],
});

// Route 5: Feedback Collection - String-only condition
agent.createRoute({
  title: "Customer Feedback",
  description: "Collect customer feedback and satisfaction ratings",
  // String-only condition - AI detects feedback intent
  when: "Customer wants to provide feedback, leave a review, or share their experience",
  requiredFields: ["satisfactionRating"],
  optionalFields: ["followUpNeeded"],
  steps: [
    {
      id: "collect_satisfaction_rating",
      description: "Ask for satisfaction rating",
      prompt: "Thank you for wanting to share feedback! On a scale of 1 to 5, how satisfied are you with our service today?",
      collect: ["satisfactionRating"],
    },
    {
      id: "ask_for_follow_up",
      description: "Check if follow-up is needed",
      prompt: "Thank you for the rating! Would you like someone from our team to follow up with you about your experience?",
      collect: ["followUpNeeded"],
      requires: ["satisfactionRating"],
    },
    {
      id: "thank_for_feedback",
      description: "Thank customer for feedback",
      prompt: "We really appreciate your feedback! It helps us improve our service for all customers.",
      requires: ["satisfactionRating"],
    },
  ],
});

// Route 6: Greeting and Welcome - String-only condition
agent.createRoute({
  title: "Welcome and Greeting",
  description: "Welcome new customers and handle greetings",
  // String-only condition - AI recognizes greetings and welcomes
  when: "Customer is greeting, saying hello, or appears to be new to the service",
  steps: [
    {
      id: "welcome_customer",
      description: "Provide warm welcome",
      prompt: "Hello! Welcome to our customer service. I'm here to help you with any questions or concerns you might have. How can I assist you today?",
    },
  ],
});

// Demonstration function
async function demonstrateStringOnlyConditions() {
  console.log("=== String-Only Conditions Demo ===\n");
  console.log("This demo shows how string conditions let the AI make routing decisions based on natural language understanding.\n");

  const testScenarios = [
    {
      name: "Billing Issue",
      message: "Hi, I was charged twice for my subscription this month and I need help getting a refund",
      expectedRoute: "Billing Support"
    },
    {
      name: "Technical Problem", 
      message: "My app keeps crashing every time I try to upload a file, can you help me fix this?",
      expectedRoute: "Technical Support"
    },
    {
      name: "Account Changes",
      message: "I need to update my email address and change my password on my account",
      expectedRoute: "Account Management"
    },
    {
      name: "General Question",
      message: "What are your business hours and do you offer phone support?",
      expectedRoute: "General Information"
    },
    {
      name: "Feedback",
      message: "I had a great experience with your support team yesterday and wanted to leave some positive feedback",
      expectedRoute: "Customer Feedback"
    },
    {
      name: "Greeting",
      message: "Hello! I'm new to your service and not sure where to start",
      expectedRoute: "Welcome and Greeting"
    },
  ];

  for (const scenario of testScenarios) {
    console.log(`🔍 Testing: ${scenario.name}`);
    console.log(`📝 Message: "${scenario.message}"`);
    
    try {
      const response = await agent.respond({
        history: [
          {
            role: "user",
            content: scenario.message,
            name: "Customer",
          },
        ],
      });

      console.log(`🎯 Routed to: ${response.session?.currentRoute?.title || "No route"}`);
      console.log(`✅ Expected: ${scenario.expectedRoute}`);
      console.log(`🤖 Response: ${response.message.substring(0, 100)}...`);
      console.log();
    } catch (error) {
      console.log(`❌ Error: ${error}`);
      console.log();
    }
  }

  console.log("💡 Key Benefits of String-Only Conditions:");
  console.log("   - Natural language understanding for routing");
  console.log("   - No need to write complex programmatic logic");
  console.log("   - AI handles intent recognition automatically");
  console.log("   - Easy to maintain and update conditions");
  console.log("   - Perfect for conversational, intent-based routing");
}

// Run demonstration
async function main() {
  try {
    await demonstrateStringOnlyConditions();
  } catch (error) {
    console.error("Error:", error);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { agent, demonstrateStringOnlyConditions };