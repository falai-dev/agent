/**
 * Business Onboarding Example
 * Updated for v2 architecture with session state management and schema-first data extraction
 *
 * Real-world example showing:
 * - Complex multi-step onboarding flow with schema-based data extraction
 * - Tools with enhanced context access for automatic state management
 * - Lifecycle hooks for data validation and persistence
 * - Branching logic (physical vs online business) with skipIf conditions
 * - Code-based state progression instead of fuzzy conditions
 */

import {
  Agent,
  defineTool,
  END_ROUTE,
  EventSource,
  createMessageEvent,
  OpenAIProvider,
  createSession,
  type ToolContext,
} from "../src/index";

// ==================== Types ====================

interface BusinessInfo {
  businessName?: string;
  businessDescription?: string;
  businessSector?: string;
}

interface LocationInfo {
  address?: string;
  city?: string;
  state?: string;
  hasPhysicalStore?: boolean;
}

interface ContactInfo {
  website?: string;
  openingHours?: string;
}

interface PaymentInfo {
  paymentMethods?: string[];
  pixInfo?: {
    pixKey: string;
    pixType: "cpf" | "cnpj" | "email" | "phone" | "random";
  };
  installmentOptions?: string;
}

interface ProductsInfo {
  products?: string[];
  services?: string[];
  targetAudience?: string;
}

interface RouteInfo {
  title: string;
  description: string;
  keywords: string[];
  responseStyle: "formal" | "casual" | "professional" | "friendly";
  actions: string[];
}

interface OnboardingData {
  business?: BusinessInfo;
  location?: LocationInfo;
  contact?: ContactInfo;
  payment?: PaymentInfo;
  productsServices?: ProductsInfo;
  routes: RouteInfo[];
}

interface OnboardingContext {
  userId: string;
  userName: string;
  sessionId: string;
  collectedData: OnboardingData;
}

// ==================== Tools ====================

/**
 * Save business information
 */
const saveBusinessInfo = defineTool<
  OnboardingContext,
  [name: string, description: string, sector: string],
  boolean
>(
  "save_business_info",
  async (
    toolContext: ToolContext<OnboardingContext>,
    name: string,
    description: string,
    sector: string
  ) => {
    // Return contextUpdate to automatically update context
    return {
      data: true,
      contextUpdate: {
        collectedData: {
          ...toolContext.context.collectedData,
          business: {
            businessName: name,
            businessDescription: description,
            businessSector: sector,
          },
        },
      },
    };
  },
  {
    description:
      "Save basic business information: company name, description, and sector",
  }
);

/**
 * Save products and services information
 */
const saveProductsServices = defineTool<
  OnboardingContext,
  [products: string[], services: string[], targetAudience: string],
  boolean
>(
  "save_products_services",
  async (
    toolContext: ToolContext<OnboardingContext>,
    products: string[],
    services: string[],
    targetAudience: string
  ) => {
    return {
      data: true,
      contextUpdate: {
        collectedData: {
          ...toolContext.context.collectedData,
          productsServices: {
            products,
            services,
            targetAudience,
          },
        },
      },
    };
  },
  {
    description: "Save products, services offered, and target audience",
  }
);

/**
 * Save location information
 */
const saveLocationInfo = defineTool<
  OnboardingContext,
  [address: string, city: string, state: string, hasPhysicalStore: boolean],
  boolean
>(
  "save_location_info",
  async (
    toolContext: ToolContext<OnboardingContext>,
    address: string,
    city: string,
    state: string,
    hasPhysicalStore: boolean
  ) => {
    return {
      data: true,
      contextUpdate: {
        collectedData: {
          ...toolContext.context.collectedData,
          location: {
            address,
            city,
            state,
            hasPhysicalStore,
          },
        },
      },
    };
  },
  {
    description:
      "Save location information: full address, city, state, and physical store status",
  }
);

/**
 * Save contact information
 */
const saveContactInfo = defineTool<
  OnboardingContext,
  [website: string, openingHours: string],
  boolean
>(
  "save_contact_info",
  async (
    toolContext: ToolContext<OnboardingContext>,
    website: string,
    openingHours: string
  ) => {
    return {
      data: true,
      contextUpdate: {
        collectedData: {
          ...toolContext.context.collectedData,
          contact: {
            website,
            openingHours,
          },
        },
      },
    };
  },
  {
    description: "Save contact information: website/URL and business hours",
  }
);

/**
 * Save payment information
 */
const savePaymentInfo = defineTool<
  OnboardingContext,
  [
    paymentMethods: string[],
    pixKey: string,
    pixType: string,
    installmentOptions: string
  ],
  boolean
>(
  "save_payment_info",
  async (
    toolContext: ToolContext<OnboardingContext>,
    paymentMethods: string[],
    pixKey: string,
    pixType: string,
    installmentOptions: string
  ) => {
    const pixInfo =
      pixKey && pixType
        ? {
            pixKey,
            pixType: ["cpf", "cnpj", "email", "phone", "random"].includes(
              pixType.toLowerCase()
            )
              ? (pixType.toLowerCase() as
                  | "cpf"
                  | "cnpj"
                  | "email"
                  | "phone"
                  | "random")
              : ("random" as const),
          }
        : undefined;

    return {
      data: true,
      contextUpdate: {
        collectedData: {
          ...toolContext.context.collectedData,
          payment: {
            paymentMethods,
            pixInfo,
            installmentOptions,
          },
        },
      },
    };
  },
  {
    description:
      "Save payment information: accepted methods, Pix key with type (cpf/cnpj/email/phone/random), and installment options",
  }
);

/**
 * Add a conversation route
 */
const addConversationRoute = defineTool<
  OnboardingContext,
  [
    title: string,
    description: string,
    keywords: string[],
    responseStyle: string
  ],
  boolean
>(
  "add_conversation_route",
  async (
    toolContext: ToolContext<OnboardingContext>,
    title: string,
    description: string,
    keywords: string[],
    responseStyle: string
  ) => {
    const validResponseStyles = [
      "formal",
      "casual",
      "professional",
      "friendly",
    ];
    const normalizedStyle = responseStyle.toLowerCase();

    const route: RouteInfo = {
      title,
      description,
      keywords,
      responseStyle: validResponseStyles.includes(normalizedStyle)
        ? (normalizedStyle as "formal" | "casual" | "professional" | "friendly")
        : "professional",
      actions: [],
    };

    const existingRoutes = toolContext.context.collectedData.routes || [];

    return {
      data: true,
      contextUpdate: {
        collectedData: {
          ...toolContext.context.collectedData,
          routes: [...existingRoutes, route],
        },
      },
    };
  },
  {
    description:
      "Add a new conversation route with title, description, keywords, and response style",
  }
);

/**
 * Get all collected data for review
 */
const getCollectedData = defineTool<OnboardingContext, [], OnboardingData>(
  "get_collected_data",
  async (toolContext: ToolContext<OnboardingContext>) => {
    return { data: toolContext.context.collectedData };
  },
  {
    description: "Retrieve all collected data for review",
  }
);

// ==================== Agent Creation ====================

/**
 * Create a business onboarding agent with lifecycle hooks
 * This demonstrates a real-world pattern with:
 * - beforeRespond: Load fresh context before each response
 * - onContextUpdate: Automatically persist context changes
 */
async function createBusinessOnboardingAgent(
  userId: string,
  userName: string,
  sessionId: string,
  initialData: OnboardingData = { routes: [] }
): Promise<Agent<OnboardingContext>> {
  const provider = new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY || "test-key",
    model: "gpt-5",
    backupModels: ["gpt-5-mini"],
    retryConfig: {
      timeout: 60000,
      retries: 3,
    },
  });

  // Create agent with lifecycle hooks for automatic persistence
  const agent = new Agent<OnboardingContext>({
    name: "Business Onboarding Assistant",
    description:
      "A specialized assistant that helps businesses set up intelligent conversation routes for their customers.",
    goal: "Collect comprehensive business information and create personalized conversation routes",
    ai: provider,
    context: {
      userId,
      userName,
      sessionId,
      collectedData: initialData,
    },
    // Lifecycle hooks enable agent caching!
    hooks: {
      // Load fresh context before each response
      beforeRespond: async (currentContext) => {
        // In a real app, fetch from database here
        console.log(
          `[beforeRespond] Loading fresh context for session ${sessionId}`
        );
        // Return updated context
        return currentContext;
      },

      // Automatically persist context updates
      onContextUpdate: async (newContext) => {
        // In a real app, save to database here
        console.log(
          `[onContextUpdate] Persisting context for session ${sessionId}`
        );
        console.log(
          "Updated data:",
          JSON.stringify(newContext.collectedData, null, 2)
        );
      },
    },
  });

  // Create the main onboarding route
  const onboardingRoute = agent.createRoute({
    title: "Business Onboarding",
    description: "Complete onboarding process to configure personalized routes",
    conditions: ["User is starting the onboarding process"],
  });

  // ==================== Build the Flow ====================

  // For complex flows with branching, we use step-by-step approach
  // This makes it easier to reference states for branching logic

  // Step 0: Welcome
  const welcome = onboardingRoute.initialState.transitionTo({
    chatState: `Hello ${userName}! 👋 I'm your setup assistant. I'll help you configure your WhatsApp assistant by collecting practical information about your business. ${
      initialData.business?.businessName
        ? `I see your company is "${initialData.business.businessName}".`
        : ""
    } Let's begin! This will only take a few minutes.`,
  });

  // Step 1: Business basics - Ask
  const askBusiness = welcome.transitionTo({
    chatState:
      initialData.business?.businessName &&
      initialData.business?.businessDescription &&
      initialData.business?.businessSector
        ? `Please confirm: your company is "${initialData.business.businessName}", operates in "${initialData.business.businessSector}", and "${initialData.business.businessDescription}". Is this correct?`
        : initialData.business?.businessName
        ? `Your company "${initialData.business.businessName}" - what sector do you operate in? And what exactly do you do? (brief description)`
        : "First, the basics: what's your company name, sector, and what do you do? (e.g., 'Store X, retail, we sell women's clothing')",
  });

  // Step 1: Business basics - Save
  const saveBusiness = askBusiness.transitionTo(
    { toolState: saveBusinessInfo },
    "User provided company name, sector, and description"
  );

  // Step 2: Products/Services - Ask
  const askProducts = saveBusiness.transitionTo({
    chatState:
      "Perfect! Now tell me: what are the main products or services you offer? And who is your target audience? (e.g., 'We sell women's clothing and accessories for women aged 25-45')",
  });

  // Step 2: Products/Services - Save
  const saveProducts = askProducts.transitionTo(
    { toolState: saveProductsServices },
    "User listed products/services and target audience"
  );

  // Step 3: Location - Branch point
  const askLocation = saveProducts.transitionTo({
    chatState:
      "Great! Do you have a physical store or in-person service location? (answer 'yes' or 'no')",
  });

  // Step 3a: Physical store path
  const askPhysicalLocation = askLocation.transitionTo(
    {
      chatState:
        "I see! Since you have a physical presence, I need the complete address (street, number, city, and state) and business hours. This is important for your assistant to inform customers. (e.g., 'José Silva Street, 123, São Paulo - SP - Mon to Fri: 9am to 6pm')",
    },
    "User has a physical store"
  );

  const savePhysicalLocation = askPhysicalLocation.transitionTo(
    { toolState: saveLocationInfo },
    "User provided physical address"
  );

  // Step 3b: Online-only path
  const askOnlineLocation = askLocation.transitionTo(
    {
      chatState:
        "Perfect! Since it's online only, please share your main website or social media where customers can find you? And what are your support hours? (e.g., 'www.example.com - 24/7 support' or 'Instagram @mycompany - Mon to Fri: 9am-6pm')",
    },
    "User does not have a physical store"
  );

  const saveOnlineLocation = askOnlineLocation.transitionTo(
    { toolState: saveContactInfo },
    "User provided website/social media and support hours"
  );

  // Step 4: Contact info (convergence point for physical stores)
  const askContact = savePhysicalLocation.transitionTo({
    chatState:
      "Do you also have a website or social media? If yes, which one? (if not, you can skip by saying 'I don't have one')",
  });

  const saveContact = askContact.transitionTo(
    { toolState: saveContactInfo },
    "User provided website/social media"
  );

  // Step 5: Payment info (convergence point from both paths)
  const askPayment = saveContact.transitionTo({
    chatState:
      "Now about payment: do you sell products/services that customers pay for? If yes, what payment methods do you accept? If you accept Pix, provide the key and type (CPF, CNPJ, email, phone). Do you offer installments? (e.g., 'Pix CPF: 12345678900, Credit card up to 12x, Bank slip' - or say 'not applicable' if you don't sell)",
  });

  // Also connect online path to payment
  saveOnlineLocation.transitionTo({ state: askPayment });

  const savePayment = askPayment.transitionTo(
    { toolState: savePaymentInfo },
    "User provided payment methods or said not applicable"
  );

  // Step 6: Suggest automatic routes
  const suggestRoutes = savePayment.transitionTo({
    chatState:
      "Perfect! Now I'll create the essential routes. Based on what you told me, I'll automatically create:\n\n1. **Products and Services** - for when they ask what you offer\n2. **Pricing and Quotes** - for questions about prices\n3. **Payment Information** - payment methods and installments\n4. **Location and Contact** - address, website, and hours\n\nThese are the most important routes for any business. I'll create them automatically with the information you provided. Sound good?",
  });

  const createRoutes = suggestRoutes.transitionTo(
    { toolState: addConversationRoute },
    "User approved automatic route creation"
  );

  // Step 7: Review collected data
  const reviewData = createRoutes.transitionTo(
    { toolState: getCollectedData },
    "Routes created successfully"
  );

  // Step 8: Summary and options
  const summary = reviewData.transitionTo({
    chatState:
      "Done! ✅ I've configured everything:\n\n✓ Business information\n✓ Products/services and target audience\n✓ Location and contact\n✓ Payment methods\n✓ Essential conversation routes\n\nYour assistant is ready! It will use this information to automatically respond when customers ask. Do you want to add any custom routes or is everything good?",
  });

  // Step 9a: Add more routes
  const askCustomRoute = summary.transitionTo(
    {
      chatState:
        "Got it! Tell me about this additional route: what's the title, what kind of questions should it answer, and what keywords do customers use? (e.g., 'Warranty and Exchange - answers about warranty, exchange, and returns - keywords: warranty, exchange, return')",
    },
    "User wants to add more routes"
  );

  const saveCustomRoute = askCustomRoute.transitionTo(
    { toolState: addConversationRoute },
    "User provided custom route information"
  );

  // Loop back to summary after adding custom route
  saveCustomRoute.transitionTo({ state: summary });

  // Step 9b: Final confirmation
  const completion = summary.transitionTo(
    {
      chatState:
        "🎉 Perfect! Setup complete! Your WhatsApp assistant is ready and will use all this information to automatically serve your customers. If you have any questions or need adjustments, just let me know!",
    },
    "User confirmed everything is okay"
  );

  completion.transitionTo({ state: END_ROUTE });

  // ==================== Alternative: Chained Approach ====================
  // For simpler linear flows, you can use chaining for conciseness:

  // Example of a simple feedback collection route
  const feedbackRoute = agent.createRoute({
    title: "Collect Feedback",
    description: "Quick feedback collection from completed onboarding",
    conditions: ["User wants to provide feedback"],
  });

  // Beautiful fluent chaining for linear flows
  feedbackRoute.initialState
    .transitionTo({
      id: "ask_rating",
      chatState: "How would you rate your onboarding experience? (1-5 stars)",
    })
    .transitionTo({
      id: "ask_liked_most",
      chatState: "What did you like most about the process?",
    })
    .transitionTo({
      id: "ask_improve",
      chatState: "Is there anything we could improve?",
    })
    .transitionTo({
      id: "thank_you",
      chatState: "Thank you for your feedback! It helps us improve. 🙏",
    })
    .transitionTo({ state: END_ROUTE });

  // ==================== Global Guidelines ====================

  agent
    .createGuideline({
      id: "guideline_confused",
      condition: "User seems confused or doesn't understand something",
      action:
        "Be patient and provide practical examples of what you need. E.g., 'José Silva Street, 123, São Paulo - SP' for address",
    })
    .createGuideline({
      id: "guideline_incomplete",
      condition: "User provides incomplete or very vague information",
      action:
        "Politely ask for the missing specific details. E.g., 'You mentioned the address, but what's the city and state?'",
    })
    .createGuideline({
      id: "guideline_skip",
      condition:
        "User wants to skip information saying they don't have it or it doesn't apply",
      action:
        "Be smart: if the information is critical for their business type (e.g., address for physical store, website for e-commerce), explain the importance. If not critical, accept it and move forward saying 'no problem, that's fine'",
    })
    .createGuideline({
      id: "guideline_physical_online",
      condition: "User has physical store but said online-only or vice versa",
      action:
        "Adjust the flow dynamically: if they have a physical store, prioritize address and hours. If online-only, prioritize website/social media and digital support hours. Don't ask for irrelevant information",
    })
    .createGuideline({
      id: "guideline_why",
      condition: "User asks why they need to provide certain information",
      action:
        "Explain practically: 'This information will help your assistant automatically answer customers when they ask about this. E.g., when they ask about payment methods, the assistant will inform automatically'",
    })
    .createGuideline({
      id: "guideline_edit",
      condition:
        "User wants to edit or correct something they already provided",
      action:
        "Accept promptly and update the information: 'Of course! I'll update to...'. Use the appropriate tool to save the correction",
    })
    .createGuideline({
      id: "guideline_unrelated",
      condition: "User asks a question unrelated to onboarding",
      action:
        "Answer briefly and redirect: 'I understand, but let's finish the setup first? We're almost there!'",
    });

  return agent;
}

// ==================== Example Usage ====================

async function main() {
  console.log("=".repeat(60));
  console.log("Business Onboarding Agent - Example");
  console.log("=".repeat(60));

  // Create agent with sample initial data
  const agent = await createBusinessOnboardingAgent(
    "user_123",
    "Alice",
    "session_456",
    {
      routes: [],
      // Optionally pre-populate some data:
      // business: {
      //   businessName: "Alice's Boutique",
      // }
    }
  );

  console.log("\nAgent:", agent.name);
  console.log("Description:", agent.description);
  console.log("Routes:", agent.getRoutes().length);
  console.log("Guidelines:", agent.getGuidelines().length);

  // Print route structure
  console.log("\n" + "=".repeat(60));
  const routes = agent.getRoutes();
  for (const route of routes) {
    console.log("\n" + route.describe());
  }

  // Simulate a conversation
  console.log("\n" + "=".repeat(60));
  console.log("Conversation Simulation");
  console.log("=".repeat(60) + "\n");

  const history = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "Hi, I want to set up my assistant"
    ),
  ];

  // Generate response (requires valid API key)
  try {
    // Initialize session state for multi-turn conversation
    let session = createSession<OnboardingData>();

    const response = await agent.respond({ history, session });
    console.log("Agent:", response.message);
    console.log("\nRoute:", response.session?.currentRoute?.title);
    console.log("Extracted:", response.session?.extracted);

    // Update session with progress
    session = response.session!;

    console.log("\n✅ Session state benefits:");
    console.log("   - Data extraction tracked across turns");
    console.log("   - State progression managed automatically");
    console.log("   - Always-on routing respects intent changes");
  } catch (error: any) {
    console.log("\n(Skipping AI response - requires valid API key)");
    console.log("Error:", error.message);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { createBusinessOnboardingAgent };
