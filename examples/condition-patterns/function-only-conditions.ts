/**
 * Function-Only Conditions Example
 * 
 * This example demonstrates using function-only conditions for programmatic routing.
 * Function conditions are perfect when you need precise, deterministic routing logic
 * based on data, state, or complex business rules.
 * 
 * Key concepts:
 * - Function conditions provide programmatic evaluation only
 * - Return boolean values for routing decisions
 * - Perfect for data-driven routing scenarios
 * - Ideal for complex business logic and state-based routing
 */

import {
  Agent,
  GeminiProvider,
  type Guideline,
} from "../../src/index";

// Context for an e-commerce system
interface EcommerceContext {
  userId: string;
  userTier: "bronze" | "silver" | "gold" | "platinum";
  accountBalance: number;
  region: string;
  isBusinessAccount: boolean;
}

// Order data schema
interface OrderData {
  productId?: string;
  quantity?: number;
  totalAmount?: number;
  shippingMethod?: "standard" | "express" | "overnight";
  paymentMethod?: "credit" | "debit" | "paypal" | "crypto";
  discountApplied?: boolean;
  orderComplete?: boolean;
}

const orderSchema = {
  type: "object",
  properties: {
    productId: { type: "string" },
    quantity: { type: "number", minimum: 1 },
    totalAmount: { type: "number", minimum: 0 },
    shippingMethod: { type: "string", enum: ["standard", "express", "overnight"] },
    paymentMethod: { type: "string", enum: ["credit", "debit", "paypal", "crypto"] },
    discountApplied: { type: "boolean" },
    orderComplete: { type: "boolean" },
  },
};

// Create agent with function-only condition examples
const agent = new Agent<EcommerceContext, OrderData>({
  name: "EcommerceBot",
  description: "An e-commerce bot that uses programmatic logic for routing decisions",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY || "demo-key",
    model: "models/gemini-2.5-flash",
  }),
  context: {
    userId: "user_12345",
    userTier: "gold",
    accountBalance: 1500.00,
    region: "US",
    isBusinessAccount: false,
  },
  schema: orderSchema,
});

// Guidelines with function-only conditions for programmatic logic
const guidelines: Guideline<EcommerceContext>[] = [
  {
    // Function-only condition - check user tier for premium features
    condition: (ctx) => ctx.context?.userTier === "platinum",
    action: "Offer premium features like white-glove service, priority support, and exclusive products",
    tags: ["premium", "vip"],
  },
  {
    // Function-only condition - check account balance for payment options
    condition: (ctx) => (ctx.context?.accountBalance || 0) < 100,
    action: "Suggest payment plans or financing options for large purchases",
    tags: ["financing", "payment"],
  },
  {
    // Function-only condition - check business account status
    condition: (ctx) => ctx.context?.isBusinessAccount === true,
    action: "Offer bulk pricing, invoicing options, and business-specific features",
    tags: ["business", "bulk"],
  },
];

// Add guidelines to agent
guidelines.forEach(guideline => agent.createGuideline(guideline));

// Route 1: VIP Customer Route - Function-only condition
agent.createRoute({
  title: "VIP Customer Service",
  description: "Special handling for premium customers",
  // Function-only condition - programmatic tier check
  when: (ctx) => ctx.context?.userTier === "platinum" || ctx.context?.userTier === "gold",
  // Skip if customer has active issues
  skipIf: (ctx) => (ctx.data?.totalAmount || 0) > (ctx.context?.accountBalance || 0),
  steps: [
    {
      id: "vip_greeting",
      description: "Provide VIP greeting and priority service",
      prompt: "Welcome back! As a valued VIP customer, you have access to our premium services. How can I assist you today?",
    },
  ],
});

// Route 2: Large Order Processing - Function-only condition
agent.createRoute({
  title: "Large Order Processing",
  description: "Handle high-value orders with special processing",
  // Function-only condition - check order value
  when: (ctx) => (ctx.data?.totalAmount || 0) > 1000,
  // Skip if insufficient balance
  skipIf: (ctx) => (ctx.data?.totalAmount || 0) > (ctx.context?.accountBalance || 0) * 2,
  requiredFields: ["productId", "quantity", "totalAmount"],
  optionalFields: ["shippingMethod", "paymentMethod"],
  steps: [
    {
      id: "verify_large_order",
      description: "Verify large order details",
      prompt: "I see you're placing a large order. Let me verify the details and check for any available discounts.",
      collect: ["productId", "quantity", "totalAmount"],
    },
    {
      id: "apply_bulk_discount",
      description: "Apply bulk discounts if eligible",
      prompt: "Based on your order size, you're eligible for bulk pricing. Let me apply the best available discount.",
      requires: ["totalAmount"],
    },
  ],
});

// Route 3: Business Account Route - Function-only condition
agent.createRoute({
  title: "Business Account Services",
  description: "Specialized services for business customers",
  // Function-only condition - check business account status
  when: (ctx) => ctx.context?.isBusinessAccount === true,
  // Skip if personal shopping (small quantities)
  skipIf: (ctx) => (ctx.data?.quantity || 0) < 10,
  steps: [
    {
      id: "business_options",
      description: "Present business-specific options",
      prompt: "I see you're shopping with a business account. Would you like to see bulk pricing, invoicing options, or set up recurring orders?",
    },
  ],
});

// Route 4: Regional Compliance Route - Function-only condition
agent.createRoute({
  title: "Regional Compliance",
  description: "Handle region-specific requirements and restrictions",
  // Function-only condition - check region for compliance
  when: (ctx) => ctx.context?.region === "EU" || ctx.context?.region === "CA",
  // Skip if already compliant
  skipIf: (ctx) => ctx.data?.orderComplete === true,
  steps: [
    {
      id: "compliance_check",
      description: "Verify regional compliance requirements",
      prompt: "I need to verify some regional compliance requirements for your order. This will just take a moment.",
    },
  ],
});

// Route 5: Payment Method Route - Function-only condition
agent.createRoute({
  title: "Payment Processing",
  description: "Handle payment method selection and processing",
  // Function-only condition - check if payment method is needed
  when: (ctx) => !ctx.data?.paymentMethod && (ctx.data?.totalAmount || 0) > 0,
  // Skip if order is already complete
  skipIf: (ctx) => ctx.data?.orderComplete === true,
  requiredFields: ["paymentMethod"],
  steps: [
    {
      id: "select_payment_method",
      description: "Help customer select payment method",
      prompt: "What payment method would you like to use for this order?",
      collect: ["paymentMethod"],
    },
    {
      id: "process_payment",
      description: "Process the payment",
      prompt: "Processing your payment now. Please wait a moment...",
      requires: ["paymentMethod", "totalAmount"],
    },
  ],
});

// Route 6: Shipping Options Route - Function-only condition
agent.createRoute({
  title: "Shipping Selection",
  description: "Handle shipping method selection based on customer tier and order value",
  // Function-only condition - check if shipping is needed
  when: (ctx) => Boolean(!ctx.data?.shippingMethod && ctx.data?.productId),
  // Skip if digital product (no shipping needed)
  skipIf: (ctx) => Boolean(ctx.data?.productId?.startsWith("digital_")),
  optionalFields: ["shippingMethod"],
  steps: [
    {
      id: "shipping_options",
      description: "Present shipping options based on customer tier",
      prompt: "Let me show you the available shipping options for your order.",
      collect: ["shippingMethod"],
      // Function-only when condition for step
      when: (ctx) => {
        // VIP customers get free express shipping
        if (ctx.context?.userTier === "platinum" || ctx.context?.userTier === "gold") {
          return true;
        }
        // Regular customers need to choose
        return (ctx.data?.totalAmount || 0) > 50;
      },
    },
  ],
});

// Route 7: Order Completion Route - Function-only condition
agent.createRoute({
  title: "Order Completion",
  description: "Finalize and complete the order",
  // Function-only condition - check if order is ready to complete
  when: (ctx) => {
    return !!(ctx.data?.productId &&
      ctx.data?.quantity &&
      ctx.data?.totalAmount &&
      ctx.data?.paymentMethod &&
      !ctx.data?.orderComplete);
  },
  // Never skip order completion
  skipIf: ()=>false,
  steps: [
    {
      id: "finalize_order",
      description: "Complete the order",
      prompt: "Perfect! Let me finalize your order now.",
      requires: ["productId", "quantity", "totalAmount", "paymentMethod"],
    },
  ],
});

// Demonstration function
async function demonstrateFunctionOnlyConditions() {
  console.log("=== Function-Only Conditions Demo ===\n");
  console.log("This demo shows how function conditions enable precise, programmatic routing decisions.\n");

  const testScenarios = [
    {
      name: "VIP Customer",
      context: { userTier: "platinum" as const, accountBalance: 5000, region: "US", isBusinessAccount: false },
      message: "I'd like to place an order",
      expectedRoute: "VIP Customer Service"
    },
    {
      name: "Large Order",
      context: { userTier: "silver" as const, accountBalance: 2000, region: "US", isBusinessAccount: false },
      data: { totalAmount: 1500 },
      message: "I want to buy this expensive item",
      expectedRoute: "Large Order Processing"
    },
    {
      name: "Business Account",
      context: { userTier: "bronze" as const, accountBalance: 1000, region: "US", isBusinessAccount: true },
      message: "I need to place a bulk order for my company",
      expectedRoute: "Business Account Services"
    },
    {
      name: "EU Customer",
      context: { userTier: "silver" as const, accountBalance: 800, region: "EU", isBusinessAccount: false },
      message: "I want to place an order",
      expectedRoute: "Regional Compliance"
    },
    {
      name: "Payment Needed",
      context: { userTier: "bronze" as const, accountBalance: 500, region: "US", isBusinessAccount: false },
      data: { productId: "prod_123", quantity: 2, totalAmount: 200 },
      message: "How do I pay for this?",
      expectedRoute: "Payment Processing"
    },
    {
      name: "Shipping Selection",
      context: { userTier: "gold" as const, accountBalance: 1200, region: "US", isBusinessAccount: false },
      data: { productId: "prod_456", quantity: 1, totalAmount: 150, paymentMethod: "credit" as const },
      message: "What shipping options do I have?",
      expectedRoute: "Shipping Selection"
    },
  ];

  for (const scenario of testScenarios) {
    console.log(`🔍 Testing: ${scenario.name}`);
    console.log(`📝 Message: "${scenario.message}"`);

    // Create agent with specific context for this scenario
    const testAgent = new Agent<EcommerceContext, OrderData>({
      name: "TestBot",
      description: "Test bot for function conditions",
      provider: new GeminiProvider({
        apiKey: process.env.GEMINI_API_KEY || "demo-key",
        model: "models/gemini-2.5-flash",
      }),
      context: {
        userId: "test_user",
        ...scenario.context,
      },
      schema: orderSchema,
    });

    // Copy routes from main agent
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
        session: scenario.data ? { id: "test-scenario", data: scenario.data } : undefined,
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

  console.log("💡 Key Benefits of Function-Only Conditions:");
  console.log("   - Precise, deterministic routing logic");
  console.log("   - Access to full context and data for decisions");
  console.log("   - Complex business rules and state-based routing");
  console.log("   - Type-safe condition evaluation");
  console.log("   - Perfect for data-driven applications");
}

// Run demonstration
async function main() {
  try {
    await demonstrateFunctionOnlyConditions();
  } catch (error) {
    console.error("Error:", error);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { agent, demonstrateFunctionOnlyConditions };