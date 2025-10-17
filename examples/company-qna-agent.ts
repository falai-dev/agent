/**
 * Example: Company Q&A Agent (Stepless, Knowledge-Based)
 *
 * This demonstrates:
 * 1. Schema-first architecture for stepless Q&A routes (no schema)
 * 2. Tools for context enrichment (not data extraction)
 * 3. Session step management even for stepless conversations
 * 4. Always-on routing with context awareness
 * 5. Three-phase pipeline: PREPARATION → ROUTING → RESPONSE
 */

import {
  Agent,
  createSession,
  EventSource,
  createMessageEvent,
  EventKind,
  END_ROUTE,
  OpenAIProvider,
} from "../src";
import type { Event } from "../src/types";
import type { ToolRef } from "../src/types/tool";

// ==============================================================================
// CONTEXT: Company Knowledge Base
// ==============================================================================

interface CompanyContext {
  companyInfo: {
    name: string;
    founded: number;
    employees: number;
    headquarters: string;
  };
  products: Array<{
    id: string;
    name: string;
    description: string;
    price: string;
    category: string;
  }>;
  policies: {
    returnPolicy: string;
    shippingPolicy: string;
    warrantyPolicy: string;
  };
  faqs: Array<{
    question: string;
    answer: string;
    category: string;
  }>;
  recentNews?: Array<{
    title: string;
    date: string;
    summary: string;
  }>;
}

interface FeedbackData {
  rating?: number;
  comments?: string;
  contactPermission?: boolean;
}

// ==============================================================================
// TOOLS: Context Enrichment (PREPARATION Phase)
// ==============================================================================

// Tool: Fetch latest company news (context enrichment)
const fetchNewsTool: ToolRef<CompanyContext, [], void> = {
  id: "fetch_news",
  name: "Fetch Company News",
  description: "Retrieve latest company news and updates",
  handler: async (context) => {
    // Simulate API call to news service
    const news = [
      {
        title: "New Product Launch: Acme Widget Pro",
        date: "2025-10-10",
        summary: "We're excited to announce the Acme Widget Pro...",
      },
      {
        title: "Company Expands to European Market",
        date: "2025-10-01",
        summary: "Acme Corp opens new offices in London and Berlin...",
      },
    ];

    console.log(`[Tool] Fetched ${news.length} news articles`);

    return {
      data: undefined,
      contextUpdate: {
        recentNews: news,
      },
    };
  },
};

// Tool: Search knowledge base (context enrichment)
const searchKnowledgeTool: ToolRef<CompanyContext, [], string> = {
  id: "search_knowledge",
  name: "Search Knowledge Base",
  description: "Search FAQs and documentation",
  handler: async (context) => {
    const { history } = context;

    // Get last user message
    const lastMessage = history
      .filter(
        (e) => e.kind === EventKind.MESSAGE && e.source === EventSource.CUSTOMER
      )
      .pop();

    if (!lastMessage) {
      return { data: "No query found" };
    }

    const query = (lastMessage.data as any).message.toLowerCase();

    // Simple keyword matching (in real app, use vector search)
    const relevantFaqs = context.context.faqs.filter(
      (faq) =>
        faq.question.toLowerCase().includes(query) ||
        faq.answer.toLowerCase().includes(query)
    );

    console.log(`[Tool] Found ${relevantFaqs.length} relevant FAQs`);

    return {
      data: relevantFaqs
        .map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`)
        .join("\n\n"),
    };
  },
};

// ==============================================================================
// AGENT SETUP
// ==============================================================================

const agent = new Agent<CompanyContext>({
  name: "Acme Support Agent",
  goal: "Answer questions about Acme Corp and our products",
  description:
    "I'm here to help you learn about Acme Corp, our products, and policies",
  personality:
    "Friendly, helpful, and knowledgeable. Always professional but approachable.",
  ai: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY || "test-key",
    model: "gpt-5o-mini",
  }),

  // Initialize with company knowledge
  context: {
    companyInfo: {
      name: "Acme Corporation",
      founded: 2010,
      employees: 500,
      headquarters: "San Francisco, CA",
    },
    products: [
      {
        id: "widget-1",
        name: "Acme Widget",
        description: "Our flagship product for all your widget needs",
        price: "$99.99",
        category: "widgets",
      },
      {
        id: "gadget-1",
        name: "Acme Gadget",
        description: "The revolutionary gadget that changed everything",
        price: "$149.99",
        category: "gadgets",
      },
    ],
    policies: {
      returnPolicy: "30-day money-back guarantee, no questions asked",
      shippingPolicy:
        "Free shipping on orders over $50. 2-5 business days delivery",
      warrantyPolicy: "1-year warranty on all products",
    },
    faqs: [
      {
        question: "What is your return policy?",
        answer: "We offer a 30-day money-back guarantee on all products.",
        category: "returns",
      },
      {
        question: "Do you ship internationally?",
        answer: "Yes, we ship to over 50 countries worldwide.",
        category: "shipping",
      },
      {
        question: "How long is the warranty?",
        answer: "All products come with a 1-year manufacturer warranty.",
        category: "warranty",
      },
    ],
  },

  // Add domain terms for better understanding
  terms: [
    {
      name: "Widget",
      description: "Our core product line for task automation",
    },
    {
      name: "Gadget",
      description: "Advanced tools for power users",
    },
  ],

  // General guidelines (no tools attached - just behavioral)
  guidelines: [
    {
      action: "Always be polite and professional",
      enabled: true,
    },
    {
      action:
        "If you don't know the answer, admit it and offer to connect them with a human",
      enabled: true,
    },
    {
      action: "Provide specific, accurate information from the knowledge base",
      enabled: true,
    },
  ],
});

// ==============================================================================
// ROUTES: STEPLESS Q&A ROUTES (Schema-First Architecture)
// ==============================================================================

// Route 1: Company Information (stepless - no data extraction)
const companyInfoRoute = agent.createRoute({
  title: "Company Information",
  description: "Answer general questions about Acme Corp",
  conditions: [
    "User asks about the company",
    "Questions about company history, size, location",
    "When was the company founded",
    "How many employees",
    "Where is the headquarters",
  ],
  // NO schema - stepless Q&A route
  // Just use initial step with instructions for response generation
});

// Initial step: Answer from knowledge base (no data collecting needed)

// Route 2: Product Information (stepless)
const productInfoRoute = agent.createRoute({
  title: "Product Information",
  description: "Answer questions about products",
  conditions: [
    "User asks about products",
    "Questions about features, pricing, availability",
    "What products do you offer",
    "Tell me about your widgets",
  ],
  // NO schema - just answering questions
});

// Initial step is enough - no transitions needed for simple Q&A

// Route 3: Policy Questions (stepless)
const policyRoute = agent.createRoute({
  title: "Policy Information",
  description: "Answer questions about company policies",
  conditions: [
    "User asks about policies",
    "Return policy",
    "Shipping information",
    "Warranty questions",
  ],
  // NO schema
});

// Initial step is enough - no extra setup needed

// Route 4: News & Updates (uses tool, but still stepless)
const newsRoute = agent.createRoute({
  title: "Company News",
  description: "Share latest company news and updates",
  conditions: [
    "User asks about news",
    "What's new",
    "Recent updates",
    "Latest announcements",
  ],
});

// Add tool to initial step to fetch news
const fetchNews = newsRoute.initialStep.nextStep({
  tool: fetchNewsTool,
});

const shareNews = fetchNews.nextStep({
  instructions: "Share the latest company news from context",
});

// Route 5: General FAQ Search (uses tool)
const faqRoute = agent.createRoute({
  title: "FAQ Search",
  description: "Search FAQs for relevant answers",
  conditions: [
    "User has a question that might be in FAQs",
    "How do I...",
    "Can I...",
    "Is there...",
  ],
});

const searchFaqs = faqRoute.initialStep.nextStep({
  tool: searchKnowledgeTool,
});

const provideFaqAnswer = searchFaqs.nextStep({
  instructions: "Provide answer based on FAQ search results",
});

// Route 6: Fallback (generic response)
const fallbackRoute = agent.createRoute({
  title: "General Conversation",
  description: "Handle general conversation or unclear questions",
  conditions: [
    "User message doesn't match other routes",
    "Greetings",
    "Small talk",
    "Unclear intent",
  ],
});

// Initial step is enough for fallback conversations

// Route 7: Collect Feedback (Stepful Example)
const feedbackRoute = agent.createRoute<FeedbackData>({
  title: "Collect Feedback",
  description: "Collect user feedback about their experience",
  conditions: ["User wants to leave feedback", "User seems satisfied or upset"],
  schema: {
    type: "object",
    properties: {
      rating: {
        type: "number",
        description: "A rating from 1 to 5",
        minimum: 1,
        maximum: 5,
      },
      comments: { type: "string", description: "Open-ended feedback" },
      contactPermission: {
        type: "boolean",
        description: "Permission to contact the user for more details",
      },
    },
    required: ["rating", "comments"],
  },
  endStep: {
    instructions:
      "Thank the user warmly for their valuable feedback and let them know we appreciate their time",
  },
});

feedbackRoute.initialStep
  .nextStep({
    id: "ask_rating",
    instructions:
      "I'd love to hear your feedback. On a scale of 1 to 5, how would you rate your experience with me today?",
    collect: ["rating"],
  })
  .nextStep({
    id: "ask_comments",
    instructions:
      "Thanks for the rating! Do you have any specific comments or suggestions?",
    collect: ["comments"],
    requires: ["rating"],
  })
  .nextStep({
    id: "ask_permission",
    instructions:
      "Thank you for the detailed feedback. Would it be okay if our team contacted you for more details?",
    collect: ["contactPermission"],
    requires: ["comments"],
  })
  .nextStep({ step: END_ROUTE }); // Uses route-level endStep configuration

// ==============================================================================
// USAGE EXAMPLES: Three-Phase Pipeline Demonstration
// ==============================================================================

async function exampleConversations() {
  let session = createSession();

  // =========================================================================
  // Example 1: Simple company info question (stepless)
  // =========================================================================
  console.log("\n=== EXAMPLE 1: Company Info (Stepless Q&A) ===");
  const history1: Event[] = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "User",
      "How many employees does Acme have?"
    ),
  ];

  const response1 = await agent.respond({ history: history1, session });
  console.log("AI:", response1.message);
  console.log("Route:", response1.session?.currentRoute?.title);

  /*
   * ARCHITECTURE FLOW:
   * 1. PREPARATION: No tools needed for simple Q&A
   * 2. ROUTING: Framework routes to "Company Information" (score: 95)
   * 3. RESPONSE: AI answers from context knowledge
   *    - Route: "Company Information"
   *    - Session: Updated with route/step (even for stepless)
   *    - No data extraction (stepless route)
   */

  // =========================================================================
  // Example 2: Product question (stepless)
  // =========================================================================
  console.log("\n=== EXAMPLE 2: Product Info ===");
  const history2: Event[] = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "User",
      "What products do you offer?"
    ),
  ];

  const response2 = await agent.respond({ history: history2, session });
  console.log("AI:", response2.message);
  console.log("Route:", response2.session?.currentRoute?.title);
  // Expected: "We offer two main products: Acme Widget ($99.99)..."
  // Route: "Product Information"

  // =========================================================================
  // Example 3: Policy question (stepless)
  // =========================================================================
  console.log("\n=== EXAMPLE 3: Policy Question ===");
  const history3: Event[] = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "User",
      "What's your return policy?"
    ),
  ];

  const response3 = await agent.respond({ history: history3, session });
  console.log("AI:", response3.message);
  console.log("Route:", response3.session?.currentRoute?.title);
  // Expected: "We offer a 30-day money-back guarantee..."
  // Route: "Policy Information"

  // =========================================================================
  // Example 4: News request (tool execution, but still stepless)
  // =========================================================================
  console.log("\n=== EXAMPLE 4: Latest News ===");
  const history4: Event[] = [
    createMessageEvent(EventSource.CUSTOMER, "User", "What's new at Acme?"),
  ];

  const response4 = await agent.respond({ history: history4, session });
  console.log("AI:", response4.message);
  console.log("Route:", response4.session?.currentRoute?.title);
  // Tool fetches news → Updates context → AI responds with news
  // Route: "Company News"
  // NO data extraction - tool just enriches context

  // =========================================================================
  // Example 5: Multi-turn conversation (context maintained)
  // =========================================================================
  console.log("\n=== EXAMPLE 5: Multi-turn ===");

  // Turn 1
  const turn1: Event[] = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "User",
      "Tell me about the Acme Widget"
    ),
  ];
  const resp1 = await agent.respond({ history: turn1, session });
  console.log("User: Tell me about the Acme Widget");
  console.log("AI:", resp1.message);

  // Turn 2 - follow-up question
  const turn2: Event[] = [
    ...turn1,
    createMessageEvent(EventSource.AI_AGENT, "Agent", resp1.message),
    createMessageEvent(EventSource.CUSTOMER, "User", "How much does it cost?"),
  ];
  const resp2 = await agent.respond({
    history: turn2,
    session: resp1.session, // Pass previous session
  });
  console.log("User: How much does it cost?");
  console.log("AI:", resp2.message);
  // AI understands "it" refers to Acme Widget from context

  // =========================================================================
  // Example 6: Stepful feedback collection
  // =========================================================================
  console.log("\n=== EXAMPLE 6: Stepful Feedback Collection ===");
  const feedbackHistory: Event[] = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "User",
      "This was very helpful, I want to leave some feedback."
    ),
  ];

  const feedbackResponse = await agent.respond({
    history: feedbackHistory,
    session,
  });
  console.log("AI:", feedbackResponse.message);
  console.log("Route:", feedbackResponse.session?.currentRoute?.title);

  if (feedbackResponse.isRouteComplete) {
    console.log("\n✅ Feedback collection complete!");
    await processFeedback(agent.getData(feedbackResponse.session?.id));
  } else {
    console.log("\n⏳ Feedback collection in progress...");
  }
}

/**
 * Mock function to process collected feedback.
 * @param data The feedback data collected from the user.
 */
async function processFeedback(data: Partial<FeedbackData>) {
  console.log("\n" + "=".repeat(60));
  console.log("Processing user feedback...");
  console.log("=".repeat(60));
  console.log("Rating:", data.rating);
  console.log("Comments:", data.comments);
  console.log("Permission to contact:", data.contactPermission);

  // Here you would typically save this to a database or send it to a support system.
  await new Promise((resolve) => setTimeout(resolve, 500)); // Simulate async operation
  console.log("Feedback logged successfully!");
  console.log("=".repeat(60));
}

// ==============================================================================
// KEY TAKEAWAYS FOR Q&A USE CASES
// ==============================================================================

/*
 * 1. NO STEP MACHINES REQUIRED
 *    - Just use the initial step with a instructions description
 *    - No collect, no skipIf, no step transitions
 *    - Perfect for stepless question-answering
 *
 * 2. ROUTING STILL WORKS
 *    - Framework routes to most relevant Q&A route
 *    - Always-on routing handles topic switches
 *    - Conditions guide the AI to the right knowledge domain
 *
 * 3. TOOLS FOR CONTEXT ENRICHMENT
 *    - Tools fetch additional data (news, search results)
 *    - Updates context (not collected data)
 *    - AI uses enriched context to answer
 *
 * 4. KNOWLEDGE IN CONTEXT
 *    - Store company knowledge in context
 *    - Use contextProvider for always-fresh data
 *    - Tools can augment context at runtime
 *
 * 5. MIX STEPFUL & STEPLESS
 *    - Have Q&A routes (stepless)
 *    - AND booking/onboarding routes (stepful)
 *    - Framework handles both seamlessly
 *
 * 6. GUIDELINES FOR BEHAVIOR
 *    - Use guidelines for general behavioral rules
 *    - No need for complex step machines for simple policies
 *    - Keep it simple!
 *
 * ARCHITECTURE FOR Q&A:
 *
 *   User Question
 *       ↓
 *   Routing (score all Q&A routes)
 *       ↓
 *   Tool Execution (if needed - fetch data)
 *       ↓
 *   Response (AI answers from context)
 *       ↓
 *   Done (no step tracking needed)
 *
 * vs. STEPFUL FLOWS (booking, onboarding):
 *
 *   User Intent
 *       ↓
 *   Routing
 *       ↓
 *   Step Machine (collect data step-by-step)
 *       ↓
 *   Tools (validate/enrich collected data)
 *       ↓
 *   Response (continue conversation)
 *       ↓
 *   Track Session (collected data, current step)
 */

if (require.main === module) {
  exampleConversations().catch(console.error);
}
