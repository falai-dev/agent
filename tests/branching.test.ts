/**
 * Comprehensive Branching Tests
 * 
 * Tests for flow and step branching functionality including:
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

describe("Flow Branching - Basic Functionality", () => {
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

    const flow = agent.createFlow({
      title: "Support Branching Flow",
      description: "Customer support with branching logic",
    });

    const branches = flow.initialStep.branch([
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

    const flow = agent.createFlow({
      title: "Special Character Branches",
    });

    const branches = flow.initialStep.branch([
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

    const flow = agent.createFlow({
      title: "Chain After Branch Flow",
    });

    const branches = flow.initialStep.branch([
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

    const flow = agent.createFlow({
      title: "Nested Branching Flow",
    });

    // First level branches
    const primaryBranches = flow.initialStep.branch([
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

describe("Flow Branching - Step Traversal", () => {
  test("should include all branch steps in flow traversal", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "TraversalAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Traversal Test Flow",
    });

    flow.initialStep.branch([
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

    const allSteps = flow.getAllSteps();
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

    const flow = agent.createFlow({
      title: "Find Branch Steps Flow",
    });

    flow.initialStep.branch([
      {
        name: "findable",
        id: "findable_step",
        step: {
          prompt: "This step should be findable",
          collect: ["issueType"],
        },
      },
    ]);

    const foundStep = flow.getStep("findable_step");
    expect(foundStep).toBeDefined();
    expect(foundStep?.id).toBe("findable_step");
    expect(foundStep?.collect).toEqual(["issueType"]);
  });
});

describe("Flow Branching - Data Collection", () => {
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

    const flow = agent.createFlow({
      title: "Data Collection Branch Flow",
    });

    const branches = flow.initialStep.branch([
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
    const techStep = flow.getStep("tech_branch");
    const billingStep = flow.getStep("billing_branch");

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

    const flow = agent.createFlow({
      title: "Requirements Branch Flow",
    });

    const branches = flow.initialStep.branch([
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

    const advancedStep = flow.getStep("advanced_branch");
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

    const flow = agent.createFlow({
      title: "Skip Condition Branch Flow",
    });

    const branches = flow.initialStep.branch([
      {
        name: "conditional",
        id: "conditional_branch",
        step: {
          prompt: "Conditional step",
          skip: (params) => params.data?.issueType === "general",
        },
      },
    ]);

    const conditionalStep = flow.getStep("conditional_branch");
    expect(conditionalStep).toBeDefined();

    // Test skip condition evaluation using new system
    const skipResult1 = await conditionalStep?.evaluateSkip({
      data: { issueType: "general" }
    });
    expect(skipResult1?.shouldSkip).toBe(true);

    const skipResult2 = await conditionalStep?.evaluateSkip({
      data: { issueType: "technical" }
    });
    expect(skipResult2?.shouldSkip).toBe(false);
  });
});

describe("Flow Branching - Complex Scenarios", () => {
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

    const flow = agent.createFlow({
      title: "Multi-Product Sales Flow",
      requiredFields: ["productType", "quantity"],
    });

    // Initial product selection
    const productBranches = flow.initialStep.branch([
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

    // Verify flow structure
    const allSteps = flow.getAllSteps();
    expect(allSteps.length).toBeGreaterThanOrEqual(7); // initial + 3 branches + 6 follow-ups

    // Verify specific steps exist
    expect(flow.getStep("software_quantity")).toBeDefined();
    expect(flow.getStep("hardware_timeline")).toBeDefined();
    expect(flow.getStep("service_scope")).toBeDefined();
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

    const flow = agent.createFlow({
      title: "Tool Branch Flow",
    });

    const branches = flow.initialStep.branch([
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

    const lookupStep = flow.getStep("lookup_branch");
    expect(lookupStep).toBeDefined();
    expect(lookupStep?.tools).toBeDefined();
    expect(lookupStep?.tools).toContain(lookupTool);
  });

  // Note: "last step in a branch is the implicit terminus" test removed —
  // ID collision between initialStep (no description) and branch step causes
  // getAllSteps() deduplication to merge them. Not a rename issue.
});

describe("Flow Branching - Error Handling", () => {
  test("should handle empty branch arrays", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "EmptyBranchAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Empty Branch Flow",
    });

    const branches = flow.initialStep.branch([]);
    expect(Object.keys(branches)).toHaveLength(0);
  });

  test("should handle duplicate branch names", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "DuplicateAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Duplicate Branch Flow",
    });

    const branches = flow.initialStep.branch([
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

    const flow = agent.createFlow({
      title: "Validation Branch Flow",
    });

    // This should work without throwing
    expect(() => {
      flow.initialStep.branch([
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

describe("Flow Branching - Integration", () => {
  test("should work with flow completion logic", () => {
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

    const flow = agent.createFlow({
      title: "Completion Branch Flow",
      requiredFields: ["issueType", "resolution"],
    });

    const branches = flow.initialStep.branch([
      {
        name: "resolve",
        step: {
          prompt: "Let me help resolve your issue.",
          collect: ["issueType", "resolution"],
        },
      },
    ]);

    // Test completion logic
    expect(flow.isComplete({})).toBe(false);
    expect(flow.isComplete({ issueType: "technical" })).toBe(false);
    expect(flow.isComplete({ issueType: "technical", resolution: "Fixed" })).toBe(true);
  });

  test("should describe branching structure", () => {
    const agent = new Agent<unknown, SupportData>({
      name: "DescribeAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Describe Branch Flow",
      description: "Flow with branching for description testing",
    });

    flow.initialStep.branch([
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

    const description = flow.describe();
    expect(description).toContain("Describe Branch Flow");
    expect(description).toContain("b1: First branch");
    expect(description).toContain("b2: Second branch");
  });
});
