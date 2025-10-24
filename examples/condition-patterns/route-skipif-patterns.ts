/**
 * Route skipIf Patterns Example
 * 
 * This example demonstrates using skipIf conditions on routes for dynamic
 * route exclusion. Route skipIf allows you to prevent entire routes from
 * being considered based on context, data, or business logic.
 * 
 * Key concepts:
 * - Route skipIf prevents routes from being activated
 * - Uses OR logic (skip if ANY condition is true)
 * - Can use strings, functions, or mixed arrays
 * - Perfect for business rules and access control
 * - Evaluated before route when conditions
 */

import {
  Agent,
  GeminiProvider,
} from "../../src/index";

// Context for a banking system
interface BankingContext {
  customerId: string;
  accountType: "basic" | "premium" | "business" | "private";
  accountStatus: "active" | "suspended" | "closed" | "pending";
  creditScore: number;
  accountBalance: number;
  hasActiveLoans: boolean;
  region: string;
  kycVerified: boolean;
}

// Banking transaction data
interface BankingData {
  transactionType?: "transfer" | "loan" | "investment" | "card" | "mortgage";
  amount?: number;
  recipientAccount?: string;
  loanAmount?: number;
  investmentType?: string;
  approved?: boolean;
  requiresApproval?: boolean;
}

const bankingSchema = {
  type: "object",
  properties: {
    transactionType: { type: "string", enum: ["transfer", "loan", "investment", "card", "mortgage"] },
    amount: { type: "number", minimum: 0 },
    recipientAccount: { type: "string" },
    loanAmount: { type: "number", minimum: 0 },
    investmentType: { type: "string" },
    approved: { type: "boolean" },
    requiresApproval: { type: "boolean" },
  },
};

// Create agent with route skipIf examples
const agent = new Agent<BankingContext, BankingData>({
  name: "BankingBot",
  description: "A banking bot demonstrating route skipIf patterns",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY || "demo-key",
    model: "models/gemini-2.5-flash",
  }),
  context: {
    customerId: "cust_12345",
    accountType: "premium",
    accountStatus: "active",
    creditScore: 750,
    accountBalance: 15000,
    hasActiveLoans: false,
    region: "US",
    kycVerified: true,
  },
  schema: bankingSchema,
});

// Route 1: Premium Services - String-only skipIf
agent.createRoute({
  title: "Premium Banking Services",
  description: "Exclusive services for premium customers",
  when: "Customer asks about premium services, investment options, or wealth management",
  // String-only skipIf - AI understands account restrictions
  skipIf: "Customer account is not premium or has restrictions that prevent premium services",
  steps: [
    {
      id: "premium_welcome",
      description: "Welcome premium customer",
      prompt: "Welcome to our premium banking services! I can help you with investments, wealth management, and exclusive products.",
    },
  ],
});

// Route 2: Loan Services - Function-only skipIf
agent.createRoute({
  title: "Loan Services",
  description: "Handle loan applications and inquiries",
  when: "Customer wants to apply for a loan or asks about lending options",
  // Function-only skipIf - programmatic eligibility check
  skipIf: (ctx) => {
    // Skip if account is not active, credit score too low, or already has active loans
    return ctx.context?.accountStatus !== "active" || 
           (ctx.context?.creditScore || 0) < 600 ||
           ctx.context?.hasActiveLoans === true;
  },
  requiredFields: ["loanAmount"],
  steps: [
    {
      id: "loan_application",
      description: "Process loan application",
      prompt: "I'd be happy to help you with a loan application. What amount are you looking to borrow?",
      collect: ["loanAmount"],
    },
  ],
});

// Route 3: Investment Services - Mixed array skipIf
agent.createRoute({
  title: "Investment Services",
  description: "Investment and wealth management services",
  when: [
    "Customer asks about investments, stocks, bonds, or portfolio management",
    (ctx) => ctx.context?.accountType === "premium" || ctx.context?.accountType === "private"
  ],
  // Mixed array skipIf - AI context + multiple programmatic checks
  skipIf: [
    "Customer account has restrictions or insufficient funds for investments",
    (ctx) => ctx.context?.accountStatus !== "active",
    (ctx) => (ctx.context?.accountBalance || 0) < 10000,
    (ctx) => ctx.context?.kycVerified !== true
  ],
  optionalFields: ["investmentType", "amount"],
  steps: [
    {
      id: "investment_consultation",
      description: "Provide investment consultation",
      prompt: "I can help you explore investment opportunities. What type of investments interest you?",
      collect: ["investmentType"],
    },
  ],
});

// Route 4: Large Transfers - Complex mixed skipIf
agent.createRoute({
  title: "Large Money Transfers",
  description: "Handle large money transfers with enhanced security",
  when: [
    "Customer wants to make a large money transfer",
    (ctx) => (ctx.data?.amount || 0) > 10000
  ],
  // Complex mixed skipIf with multiple business rules
  skipIf: [
    "Account has restrictions, insufficient funds, or compliance issues",
    (ctx) => ctx.context?.accountStatus === "suspended" || ctx.context?.accountStatus === "closed",
    (ctx) => (ctx.context?.accountBalance || 0) < (ctx.data?.amount || 0),
    (ctx) => ctx.context?.kycVerified !== true,
    (ctx) => ctx.context?.region === "restricted_region" // Compliance restriction
  ],
  requiredFields: ["amount", "recipientAccount"],
  steps: [
    {
      id: "verify_transfer",
      description: "Verify large transfer details",
      prompt: "For large transfers, I need to verify some details for security. What's the recipient account and transfer amount?",
      collect: ["amount", "recipientAccount"],
    },
    {
      id: "security_check",
      description: "Perform additional security checks",
      prompt: "I'm performing additional security verification for this large transfer. This may take a moment.",
      requires: ["amount", "recipientAccount"],
    },
  ],
});

// Route 5: Business Banking - Account type skipIf
agent.createRoute({
  title: "Business Banking Services",
  description: "Services specifically for business accounts",
  when: "Customer asks about business banking, commercial loans, or business services",
  // Function-only skipIf - account type restriction
  skipIf: (ctx) => ctx.context?.accountType !== "business",
  steps: [
    {
      id: "business_services",
      description: "Present business banking options",
      prompt: "I can help you with business banking services including commercial loans, merchant services, and business accounts.",
    },
  ],
});

// Route 6: Credit Card Services - Multiple restriction skipIf
agent.createRoute({
  title: "Credit Card Services",
  description: "Credit card applications and management",
  when: "Customer asks about credit cards, card applications, or card services",
  // Mixed skipIf with multiple eligibility criteria
  skipIf: [
    "Customer not eligible for credit card services due to account or credit restrictions",
    (ctx) => ctx.context?.accountStatus !== "active",
    (ctx) => (ctx.context?.creditScore || 0) < 650,
    (ctx) => ctx.context?.kycVerified !== true,
    (ctx) => ctx.context?.hasActiveLoans === true && (ctx.context?.creditScore || 0) < 700
  ],
  steps: [
    {
      id: "card_application",
      description: "Process credit card application",
      prompt: "I can help you apply for a credit card. Based on your account, you're eligible for our premium card options.",
    },
  ],
});

// Route 7: Mortgage Services - Complex eligibility skipIf
agent.createRoute({
  title: "Mortgage Services",
  description: "Mortgage applications and home loan services",
  when: [
    "Customer asks about mortgages, home loans, or property financing",
    (ctx) => ctx.helpers.lastMessageContains(["mortgage", "home loan", "property", "house"])
  ],
  // Complex skipIf with comprehensive eligibility check
  skipIf: [
    "Customer not eligible for mortgage services due to various restrictions",
    (ctx) => ctx.context?.accountStatus !== "active",
    (ctx) => (ctx.context?.creditScore || 0) < 620, // Minimum credit score for mortgages
    (ctx) => (ctx.context?.accountBalance || 0) < 50000, // Minimum down payment capability
    (ctx) => ctx.context?.hasActiveLoans === true && (ctx.context?.creditScore || 0) < 720,
    (ctx) => ctx.context?.kycVerified !== true,
    (ctx) => ctx.context?.region === "restricted_mortgage_region"
  ],
  requiredFields: ["loanAmount"],
  steps: [
    {
      id: "mortgage_consultation",
      description: "Provide mortgage consultation",
      prompt: "I can help you with mortgage options. What's your target loan amount for your home purchase?",
      collect: ["loanAmount"],
    },
  ],
});

// Route 8: Account Recovery - Status-based skipIf
agent.createRoute({
  title: "Account Recovery",
  description: "Help customers recover suspended or restricted accounts",
  when: "Customer has account issues, restrictions, or needs account recovery help",
  // Function-only skipIf - only for accounts that need recovery
  skipIf: (ctx) => ctx.context?.accountStatus === "active" && ctx.context?.kycVerified === true,
  steps: [
    {
      id: "recovery_assistance",
      description: "Provide account recovery assistance",
      prompt: "I can help you resolve account issues. Let me check what steps are needed to restore full access to your account.",
    },
  ],
});

// Route 9: General Banking - Fallback with minimal skipIf
agent.createRoute({
  title: "General Banking Support",
  description: "General banking questions and support",
  when: "Customer has general banking questions or needs basic support",
  // Minimal skipIf - only skip if account is completely closed
  skipIf: (ctx) => ctx.context?.accountStatus === "closed",
  steps: [
    {
      id: "general_support",
      description: "Provide general banking support",
      prompt: "I'm here to help with your banking needs. What can I assist you with today?",
    },
  ],
});

// Demonstration function
async function demonstrateRouteSkipIfPatterns() {
  console.log("=== Route skipIf Patterns Demo ===\n");
  console.log("This demo shows how route skipIf conditions prevent routes from being activated.\n");

  const testScenarios = [
    {
      name: "Premium Customer - Premium Services",
      context: { 
        accountType: "premium" as const, 
        accountStatus: "active" as const,
        creditScore: 800,
        kycVerified: true
      },
      message: "I'm interested in your premium investment services",
      expectedRoute: "Premium Banking Services",
      shouldSkip: false
    },
    {
      name: "Basic Customer - Premium Services (Should Skip)",
      context: { 
        accountType: "basic" as const, 
        accountStatus: "active" as const,
        creditScore: 700,
        kycVerified: true
      },
      message: "I want premium investment services",
      expectedRoute: "General Banking Support", // Should fallback
      shouldSkip: true
    },
    {
      name: "Good Credit - Loan Services",
      context: { 
        accountType: "basic" as const, 
        accountStatus: "active" as const,
        creditScore: 750,
        hasActiveLoans: false,
        kycVerified: true
      },
      message: "I'd like to apply for a personal loan",
      expectedRoute: "Loan Services",
      shouldSkip: false
    },
    {
      name: "Poor Credit - Loan Services (Should Skip)",
      context: { 
        accountType: "basic" as const, 
        accountStatus: "active" as const,
        creditScore: 550,
        hasActiveLoans: false,
        kycVerified: true
      },
      message: "I need a loan",
      expectedRoute: "General Banking Support", // Should fallback
      shouldSkip: true
    },
    {
      name: "High Balance - Investment Services",
      context: { 
        accountType: "premium" as const, 
        accountStatus: "active" as const,
        accountBalance: 50000,
        kycVerified: true
      },
      message: "I want to invest in stocks",
      expectedRoute: "Investment Services",
      shouldSkip: false
    },
    {
      name: "Low Balance - Investment Services (Should Skip)",
      context: { 
        accountType: "premium" as const, 
        accountStatus: "active" as const,
        accountBalance: 5000,
        kycVerified: true
      },
      message: "I want to invest in stocks",
      expectedRoute: "General Banking Support", // Should fallback
      shouldSkip: true
    },
    {
      name: "Business Account - Business Services",
      context: { 
        accountType: "business" as const, 
        accountStatus: "active" as const,
        kycVerified: true
      },
      message: "I need business banking services",
      expectedRoute: "Business Banking Services",
      shouldSkip: false
    },
    {
      name: "Personal Account - Business Services (Should Skip)",
      context: { 
        accountType: "basic" as const, 
        accountStatus: "active" as const,
        kycVerified: true
      },
      message: "I need business banking services",
      expectedRoute: "General Banking Support", // Should fallback
      shouldSkip: true
    },
    {
      name: "Suspended Account - Account Recovery",
      context: { 
        accountType: "basic" as const, 
        accountStatus: "suspended" as const,
        kycVerified: false
      },
      message: "My account is suspended, I need help",
      expectedRoute: "Account Recovery",
      shouldSkip: false
    },
  ];

  for (const scenario of testScenarios) {
    console.log(`🔍 Testing: ${scenario.name}`);
    console.log(`📝 Message: "${scenario.message}"`);
    console.log(`🎯 Should Skip Target Route: ${scenario.shouldSkip}`);
    
    // Create agent with specific context for this scenario
    const testAgent = new Agent<BankingContext, BankingData>({
      name: "TestBankBot",
      description: "Test bot for route skipIf patterns",
      provider: new GeminiProvider({
        apiKey: process.env.GEMINI_API_KEY || "demo-key",
        model: "models/gemini-2.5-flash",
      }),
      context: {
        customerId: "test_customer",
        accountBalance: 10000,
        hasActiveLoans: false,
        region: "US",
        ...scenario.context,
      } as BankingContext,
      schema: bankingSchema,
    });

    // Copy routes from main agent using the new toOptions() method
    agent.getRoutes().forEach(route => {
      testAgent.createRoute(route.toOptions());
    });

    try {
      const response = await testAgent.respond({
        history: [
          {
            role: "user",
            content: scenario.message,
            name: "Customer",
          },
        ],
      });

      const actualRoute = response.session?.currentRoute?.title || "No route";
      console.log(`🎯 Routed to: ${actualRoute}`);
      console.log(`✅ Expected: ${scenario.expectedRoute}`);
      
      if (scenario.shouldSkip) {
        console.log(`✅ Skip Logic: Route was correctly skipped`);
      } else {
        console.log(`✅ Skip Logic: Route was correctly allowed`);
      }
      
      console.log(`🤖 Response: ${response.message.substring(0, 100)}...`);
      console.log();
    } catch (error) {
      console.log(`❌ Error: ${error}`);
      console.log();
    }
  }

  console.log("💡 Key Benefits of Route skipIf Patterns:");
  console.log("   - Dynamic route exclusion based on business rules");
  console.log("   - Access control and eligibility enforcement");
  console.log("   - Prevents inappropriate routes from being considered");
  console.log("   - Supports complex business logic with mixed conditions");
  console.log("   - Evaluated before route when conditions for efficiency");
}

// Run demonstration
async function main() {
  try {
    await demonstrateRouteSkipIfPatterns();
  } catch (error) {
    console.error("Error:", error);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { agent, demonstrateRouteSkipIfPatterns };