/**
 * Comprehensive Branching Tests
 * 
 * Tests for route and step branching functionality including:
 * - Basic branching creation
 * - Branch chaining and transitions
 * - Branch ID handling
 * - Complex branching scenarios
 * - Integration with routing engine
 */
import { expect, test, describe } from "bun:test";
import { Agent, type Tool } from "../src/index";
import { MockProviderFactory } from "./mock-provider";

interface SupportData {
  issueType?: "technical" | "billing" | "account" | "general";
  accountNumber?: string;
  issueDescription?: string;
  priority?: "low" | "medium" | "high";
  resolution?: string;
  customerName?: string;
  email?: string;
}

interface OrderData {
  productType?: "software" | "hardware" | "service";
  quantity?: number;
  budget?: number;
  timeline?: string;
  requirements?: string;
}

describe("Route Branching - Basic Functionality", () => {
  test("should create branches with custom IDs", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "BranchingAgent",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          issueType: { type: "string", enum: ["technical", "billing", "account", "general"] },
          accountNumber: { type: "string" },
          issueDescription: { type: "string" },
        },
      },
    });

    const route = agent.createRoute({
      title: "Support Branching Route",
      description: "Customer support with branching logic",
    });

    const branches = route.initialStep.branch([
      {
        name: "technical",
        id: "tech_support_branch",
        step: {
          prompt: "I'll help you with your technical issue. What's the problem?",
          collect: ["issueDescription"],
        },
      },
      {
        name: "billing",
        id: "billing_support_branch", 
        step: {
          prompt: "I'll help with your billing inquiry. What's your account number?",
          collect: ["accountNumber"],
        },
      },
      {
        name: "general",
        step: {
          prompt: "How can I help you today?",
        },
      },
    ]);

    // Verify branches were created
    expect(branches.technical).toBeDefined();
    expect(branches.billing).toBeDefined();
    expect(branches.general).toBeDefined();

    // Verify custom IDs
    expect(branches.technical.id).toBe("tech_support_branch");
    expect(branches.billing.id).toBe("billing_support_branch");
    
    // General branch should have auto-generated ID
    expect(branches.general.id).toBeDefined();
    expect(branches.general.id).not.toBe("general");
  });

  test("should handle branch names with spaces and special characters", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "SpecialBranchAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Special Character Branches",
    });

    const branches = route.initialStep.branch([
      {
        name: "Customer Support",
        step: { prompt: "Customer support branch" },
      },
      {
        name: "billing-inquiry",
        step: { prompt: "Billing inquiry branch" },
      },
      {
        name: "technical_issue",
        step: { prompt: "Technical issue branch" },
      },
    ]);

    expect(branches["Customer Support"]).toBeDefined();
    expect(branches["billing-inquiry"]).toBeDefined();
    expect(branches["technical_issue"]).toBeDefined();
  });

  test("should chain steps after branches", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "ChainAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Chain After Branch Route",
    });

    const branches = route.initialStep.branch([
      {
        name: "support",
        step: {
          prompt: "Support branch",
          collect: ["issueType"],
        },
      },
    ]);

    // Chain additional steps after branch
    const step2 = branches.support.nextStep({
      id: "follow_up",
      prompt: "Can you provide more details?",
      collect: ["issueDescription"],
    });

    const step3 = step2.nextStep({
      id: "resolution",
      prompt: "Let me help resolve this issue.",
      collect: ["resolution"],
    });

    expect(step2.id).toBe("follow_up");
    expect(step3.id).toBe("resolution");
  });

  test("should create nested branches", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "NestedBranchAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Nested Branching Route",
    });

    // First level branches
    const primaryBranches = route.initialStep.branch([
      {
        name: "support",
        step: { prompt: "Support selected" },
      },
      {
        name: "sales",
        step: { prompt: "Sales selected" },
      },
    ]);

    // Second level branches under support
    const supportSubBranches = primaryBranches.support.branch([
      {
        name: "technical",
        step: { prompt: "Technical support" },
      },
      {
        name: "account",
        step: { prompt: "Account support" },
      },
    ]);

    // Second level branches under sales
    const salesSubBranches = primaryBranches.sales.branch([
      {
        name: "new_customer",
        step: { prompt: "New customer sales" },
      },
      {
        name: "existing_customer",
        step: { prompt: "Existing customer sales" },
      },
    ]);

    expect(supportSubBranches.technical).toBeDefined();
    expect(supportSubBranches.account).toBeDefined();
    expect(salesSubBranches.new_customer).toBeDefined();
    expect(salesSubBranches.existing_customer).toBeDefined();
  });
});

describe("Route Branching - Step Traversal", () => {
  test("should include all branch steps in route traversal", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "TraversalAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Traversal Test Route",
    });

    route.initialStep.branch([
      {
        name: "branch1",
        id: "b1",
        step: { prompt: "Branch 1" },
      },
      {
        name: "branch2", 
        id: "b2",
        step: { prompt: "Branch 2" },
      },
      {
        name: "branch3",
        id: "b3",
        step: { prompt: "Branch 3" },
      },
    ]);

    const allSteps = route.getAllSteps();
    const stepIds = allSteps.map(step => step.id);

    // Should include initial step + 3 branch steps
    expect(allSteps.length).toBeGreaterThanOrEqual(4);
    expect(stepIds).toContain("b1");
    expect(stepIds).toContain("b2");
    expect(stepIds).toContain("b3");
  });

  test("should find branch steps by ID", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "FindAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Find Branch Steps Route",
    });

    route.initialStep.branch([
      {
        name: "findable",
        id: "findable_step",
        step: {
          prompt: "This step should be findable",
          collect: ["issueType"],
        },
      },
    ]);

    const foundStep = route.getStep("findable_step");
    expect(foundStep).toBeDefined();
    expect(foundStep?.id).toBe("findable_step");
    expect(foundStep?.collect).toEqual(["issueType"]);
  });
});

describe("Route Branching - Data Collection", () => {
  test("should collect data in branch steps", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "DataCollectionAgent",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          issueType: { type: "string" },
          accountNumber: { type: "string" },
          issueDescription: { type: "string" },
        },
      },
    });

    const route = agent.createRoute({
      title: "Data Collection Branch Route",
    });

    const branches = route.initialStep.branch([
      {
        name: "technical",
        id: "tech_branch",
        step: {
          prompt: "Technical support",
          collect: ["issueType", "issueDescription"],
        },
      },
      {
        name: "billing",
        id: "billing_branch",
        step: {
          prompt: "Billing support", 
          collect: ["accountNumber"],
        },
      },
    ]);

    // Verify data collection configuration
    const techStep = route.getStep("tech_branch");
    const billingStep = route.getStep("billing_branch");

    expect(techStep).toBeDefined();
    expect(billingStep).toBeDefined();
    expect(techStep?.collect).toEqual(["issueType", "issueDescription"]);
    expect(billingStep?.collect).toEqual(["accountNumber"]);
  });

  test("should handle step requirements in branches", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "RequirementsAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Requirements Branch Route",
    });

    const branches = route.initialStep.branch([
      {
        name: "advanced",
        id: "advanced_branch",
        step: {
          prompt: "Advanced support",
          requires: ["issueType"],
          collect: ["resolution"],
        },
      },
    ]);

    const advancedStep = route.getStep("advanced_branch");
    expect(advancedStep).toBeDefined();
    expect(advancedStep?.requires).toEqual(["issueType"]);
    expect(advancedStep?.hasRequires({ issueType: "technical" })).toBe(true);
    expect(advancedStep?.hasRequires({})).toBe(false);
  });

  test("should handle skipIf conditions in branches", async () => {
    const agent = new Agent<unknown, SupportData>({
      name: "SkipAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Skip Condition Branch Route",
    });

    const branches = route.initialStep.branch([
      {
        name: "conditional",
        id: "conditional_branch",
        step: {
          prompt: "Conditional step",
          skipIf: (params) => params.data?.issueType === "general",
        },
      },
    ]);

    const conditionalStep = route.getStep("conditional_branch");
    expect(conditionalStep).toBeDefined();
    
    // Test skipIf condition evaluation using new system
    const skipResult1 = await conditionalStep?.evaluateSkipIf({ 
      data: { issueType: "general" } 
    });
    expect(skipResult1?.shouldSkip).toBe(true);
    
    const skipResult2 = await conditionalStep?.evaluateSkipIf({ 
      data: { issueType: "technical" } 
    });
    expect(skipResult2?.shouldSkip).toBe(false);
  });
});

describe("Route Branching - Complex Scenarios", () => {
  test("should handle multi-product sales branching", () => {
    const agent = new Agent<unknown, OrderData>({
      name: "SalesAgent",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          productType: { type: "string", enum: ["software", "hardware", "service"] },
          quantity: { type: "number" },
          budget: { type: "number" },
          timeline: { type: "string" },
          requirements: { type: "string" },
        },
      },
    });

    const route = agent.createRoute({
      title: "Multi-Product Sales Route",
      requiredFields: ["productType", "quantity"],
    });

    // Initial product selection
    const productBranches = route.initialStep.branch([
      {
        name: "software",
        id: "software_branch",
        step: {
          prompt: "Great choice! What type of software solution are you looking for?",
          collect: ["requirements"],
        },
      },
      {
        name: "hardware",
        id: "hardware_branch", 
        step: {
          prompt: "Excellent! What hardware specifications do you need?",
          collect: ["requirements"],
        },
      },
      {
        name: "service",
        id: "service_branch",
        step: {
          prompt: "Perfect! What kind of service are you interested in?",
          collect: ["requirements"],
        },
      },
    ]);

    // Each product type has different follow-up questions
    productBranches.software
      .nextStep({
        id: "software_quantity",
        prompt: "How many licenses do you need?",
        collect: ["quantity"],
      })
      .nextStep({
        id: "software_budget",
        prompt: "What's your budget range?",
        collect: ["budget"],
      });

    productBranches.hardware
      .nextStep({
        id: "hardware_quantity",
        prompt: "How many units do you need?", 
        collect: ["quantity"],
      })
      .nextStep({
        id: "hardware_timeline",
        prompt: "When do you need delivery?",
        collect: ["timeline"],
      });

    productBranches.service
      .nextStep({
        id: "service_scope",
        prompt: "What's the scope of the project?",
        collect: ["quantity"], // Using quantity for project scope
      })
      .nextStep({
        id: "service_timeline",
        prompt: "What's your timeline?",
        collect: ["timeline"],
      });

    // Verify route structure
    const allSteps = route.getAllSteps();
    expect(allSteps.length).toBeGreaterThanOrEqual(7); // initial + 3 branches + 6 follow-ups
    
    // Verify specific steps exist
    expect(route.getStep("software_quantity")).toBeDefined();
    expect(route.getStep("hardware_timeline")).toBeDefined();
    expect(route.getStep("service_scope")).toBeDefined();
  });

  test("should handle branching with tools", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "ToolBranchAgent",
      provider: MockProviderFactory.basic(),
    });

    const lookupTool: Tool<unknown, SupportData> = {
      id: "lookup_account",
      description: "Look up customer account information",
      parameters: {
        type: "object",
        properties: {
          accountNumber: { type: "string" },
        },
      },
      handler: ({ data }) => ({
        data: `Account found for ${data.accountNumber}`,
      }),
    };

    const route = agent.createRoute({
      title: "Tool Branch Route",
    });

    const branches = route.initialStep.branch([
      {
        name: "account_lookup",
        id: "lookup_branch",
        step: {
          prompt: "I'll look up your account information.",
          tools: [lookupTool],
          collect: ["accountNumber"],
        },
      },
      {
        name: "general_help",
        step: {
          prompt: "How can I help you today?",
        },
      },
    ]);

    const lookupStep = route.getStep("lookup_branch");
    expect(lookupStep).toBeDefined();
    expect(lookupStep?.tools).toBeDefined();
    expect(lookupStep?.tools).toContain(lookupTool);
  });

  test("should end branches with END_ROUTE", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "EndBranchAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "End Branch Route",
    });

    const branches = route.initialStep.branch([
      {
        name: "quick_help",
        step: {
          prompt: "Here's some quick help information.",
        },
      },
    ]);

    const endStep = branches.quick_help.endRoute({
      prompt: "Is there anything else I can help you with?",
    });

    expect(endStep.id).toBe("END_ROUTE");
  });
});

describe("Route Branching - Error Handling", () => {
  test("should handle empty branch arrays", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "EmptyBranchAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Empty Branch Route",
    });

    const branches = route.initialStep.branch([]);
    expect(Object.keys(branches)).toHaveLength(0);
  });

  test("should handle duplicate branch names", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "DuplicateAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Duplicate Branch Route",
    });

    const branches = route.initialStep.branch([
      {
        name: "support",
        step: { prompt: "First support branch" },
      },
      {
        name: "support", // Duplicate name
        step: { prompt: "Second support branch" },
      },
    ]);

    // Second branch should overwrite the first
    expect(Object.keys(branches)).toHaveLength(1);
    expect(branches.support).toBeDefined();
  });

  test("should validate branch step configurations", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "ValidationAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Validation Branch Route",
    });

    // This should work without throwing
    expect(() => {
      route.initialStep.branch([
        {
          name: "valid",
          step: {
            prompt: "Valid branch step",
            collect: ["issueType"],
          },
        },
      ]);
    }).not.toThrow();
  });
});

describe("Route Branching - Integration", () => {
  test("should work with route completion logic", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "CompletionAgent",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          issueType: { type: "string" },
          resolution: { type: "string" },
        },
      },
    });

    const route = agent.createRoute({
      title: "Completion Branch Route",
      requiredFields: ["issueType", "resolution"],
    });

    const branches = route.initialStep.branch([
      {
        name: "resolve",
        step: {
          prompt: "Let me help resolve your issue.",
          collect: ["issueType", "resolution"],
        },
      },
    ]);

    // Test completion logic
    expect(route.isComplete({})).toBe(false);
    expect(route.isComplete({ issueType: "technical" })).toBe(false);
    expect(route.isComplete({ issueType: "technical", resolution: "Fixed" })).toBe(true);
  });

  test("should describe branching structure", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "DescribeAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Describe Branch Route",
      description: "Route with branching for description testing",
    });

    route.initialStep.branch([
      {
        name: "branch1",
        id: "b1",
        step: {
          description: "First branch",
          prompt: "Branch 1",
        },
      },
      {
        name: "branch2",
        id: "b2", 
        step: {
          description: "Second branch",
          prompt: "Branch 2",
        },
      },
    ]);

    const description = route.describe();
    expect(description).toContain("Describe Branch Route");
    expect(description).toContain("b1: First branch");
    expect(description).toContain("b2: Second branch");
  });
});
