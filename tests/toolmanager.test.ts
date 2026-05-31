/**
 * ToolManager Tests
 * 
 * Tests for the new ToolManager functionality
 */
import { expect, test, describe } from "bun:test";
import { Agent, ToolManager } from "../src/index";
import type { ToolContext } from "../src/types/tool";
import { MockProvider } from "./mock-provider";

interface TestContext {
    userId: string;
    role: string;
}

interface TestData {
    name: string;
    email: string;
    score: number;
}
const provider = new MockProvider();

describe("ToolManager Core Functionality", () => {
    test("should create ToolManager instance", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        expect(toolManager).toBeDefined();
        expect(toolManager.isRegistered("nonexistent")).toBe(false);
    });

    test("should create tools with unified interface", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const tool = toolManager.create({
            id: "test-tool",
            name: "Test Tool",
            description: "A test tool",
            handler: async (context, args) => {
                return `Hello ${context.data.name || 'user'}`;
            }
        });

        expect(tool).toBeDefined();
        expect(tool.id).toBe("test-tool");
        expect(tool.name).toBe("Test Tool");
        expect(tool.description).toBe("A test tool");
        expect(tool.handler).toBeDefined();
    });

    test("should register tools", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const tool = toolManager.register({
            id: "registered-tool",
            handler: async (context) => {
                return "registered result";
            }
        });

        expect(tool).toBeDefined();
        expect(toolManager.isRegistered("registered-tool")).toBe(true);
        expect(toolManager.getRegisteredTool("registered-tool")).toBe(tool);
    });

    test("should register multiple tools", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const tools = toolManager.registerMany([
            {
                id: "tool1",
                handler: async () => "result1"
            },
            {
                id: "tool2",
                handler: async () => "result2"
            }
        ]);

        expect(tools).toHaveLength(2);
        expect(toolManager.isRegistered("tool1")).toBe(true);
        expect(toolManager.isRegistered("tool2")).toBe(true);
    });

    test("should get available tools", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        toolManager.register({
            id: "available-tool",
            handler: async () => "result"
        });

        const available = toolManager.getAvailable();
        expect(available).toHaveLength(1);
        expect(available[0].id).toBe("available-tool");
    });

    test("should find registered tools", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const tool = toolManager.register({
            id: "findable-tool",
            handler: async () => "result"
        });

        const found = toolManager.find("findable-tool");
        expect(found).toBe(tool);

        const notFound = toolManager.find("nonexistent");
        expect(notFound).toBeUndefined();
    });
});

describe("ToolManager Pattern Helpers", () => {
    test("should create data enrichment tool", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const enrichmentTool = toolManager.createDataEnrichment({
            id: "enrich-name",
            fields: ["name"],
            enricher: async (context, data) => ({
                name: `${data.name} (${context.role})`
            })
        });

        expect(enrichmentTool).toBeDefined();
        expect(enrichmentTool.id).toBe("enrich-name");
    });

    test("should create validation tool", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const validationTool = toolManager.createValidation({
            id: "validate-email",
            fields: ["email"],
            validator: async (context, data) => ({
                valid: data.email?.includes("@") || false,
                errors: [],
                warnings: []
            })
        });

        expect(validationTool).toBeDefined();
        expect(validationTool.id).toBe("validate-email");
    });

    test("should create API call tool", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const apiTool = toolManager.createApiCall({
            id: "fetch-user",
            endpoint: "https://api.example.com/users",
            method: "GET",
            transform: (response) => response
        });

        expect(apiTool).toBeDefined();
        expect(apiTool.id).toBe("fetch-user");
    });

    test("should create computation tool", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const computeTool = toolManager.createComputation({
            id: "calculate-score",
            inputs: ["score"],
            compute: async (context, inputs) => {
                return (inputs.score || 0) * 2;
            }
        });

        expect(computeTool).toBeDefined();
        expect(computeTool.id).toBe("calculate-score");
    });
});

describe("Enhanced ToolContext Implementation", () => {
    test("should provide direct access to context and data", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        let capturedContext: any;

        const tool = toolManager.create({
            id: "context-test",
            handler: async (context) => {
                capturedContext = context;
                // Test direct property access
                expect(context.context).toBeDefined();
                expect(context.data).toBeDefined();
                expect(context.history).toBeDefined();

                // Test helper methods exist
                expect(typeof context.updateContext).toBe("function");
                expect(typeof context.updateData).toBe("function");
                expect(typeof context.getField).toBe("function");
                expect(typeof context.setField).toBe("function");
                expect(typeof context.hasField).toBe("function");

                return "success";
            }
        });

        expect(tool).toBeDefined();
        expect(capturedContext).toBeUndefined(); // Not called yet
    });

    test("should handle field operations correctly", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const tool = toolManager.create({
            id: "field-test",
            handler: async (context) => {
                // Test hasField with empty data
                expect(context.hasField("name")).toBe(false);

                // Test getField with empty data
                expect(context.getField("name")).toBeUndefined();

                return "success";
            }
        });

        expect(tool).toBeDefined();
    });

    test("should support both direct return and ToolResult return", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        // Tool with direct return
        const directTool = toolManager.create({
            id: "direct-return",
            handler: async (context, args) => {
                return `Direct result: ${args?.input}`;
            }
        });

        // Tool with ToolResult return
        const toolResultTool = toolManager.create({
            id: "toolresult-return",
            handler: async (context, args) => {
                return {
                    data: `ToolResult: ${args?.input}`,
                    dataUpdate: { lastInput: args?.input },
                    contextUpdate: { lastAction: "process" }
                };
            }
        });

        expect(directTool).toBeDefined();
        expect(toolResultTool).toBeDefined();
        expect(typeof directTool.handler).toBe("function");
        expect(typeof toolResultTool.handler).toBe("function");
    });
});

describe("ToolManager Error Handling", () => {
    test("should handle tool creation errors", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        // This should not throw during creation, only during execution
        expect(() => {
            toolManager.create({
                id: "error-tool",
                handler: async () => {
                    throw new Error("Tool error");
                }
            });
        }).not.toThrow();
    });

    test("should validate tool definitions", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        // Test missing ID
        expect(() => {
            toolManager.create({
                id: "",
                handler: async () => "result"
            });
        }).toThrow("Tool ID is required");

        // Test invalid ID characters
        expect(() => {
            toolManager.create({
                id: "invalid@id",
                handler: async () => "result"
            });
        }).toThrow("Tool ID must contain only alphanumeric characters");

        // Test missing handler
        expect(() => {
            toolManager.create({
                id: "valid-id"
            } as any);
        }).toThrow("Tool handler is required");

        // Test invalid name
        expect(() => {
            toolManager.create({
                id: "",
                handler: async () => "result"
            });
        }).toThrow();
    });

    test("should validate pattern helper configurations", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        // Test data enrichment validation
        expect(() => {
            toolManager.createDataEnrichment({
                id: "test",
                fields: [],
                enricher: async () => ({})
            });
        }).toThrow("Data enrichment fields must be a non-empty array");

        // Test validation config validation
        expect(() => {
            toolManager.createValidation({
                id: "test",
                fields: ["email"],
                validator: null as any
            });
        }).toThrow("Validation validator must be a function");

        // Test API call validation
        expect(() => {
            toolManager.createApiCall({
                id: "test",
                endpoint: "",
                method: "INVALID" as any
            });
        }).toThrow("API call method must be one of: GET, POST, PUT, DELETE");

        // Test computation validation
        expect(() => {
            toolManager.createComputation({
                id: "test",
                inputs: [],
                compute: async () => "result"
            });
        }).toThrow("Computation inputs must be a non-empty array");
    });

    test("should handle invalid tool registration", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        expect(() => {
            toolManager.register({} as any);
        }).toThrow("Invalid tool for registration");

        expect(() => {
            toolManager.register(null as any);
        }).toThrow("Tool registration failed");
    });

    test("should rethrow errors when the tool handler throws", async () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const tool = {
            id: "error-execution-tool",
            handler: async () => {
                throw new Error("Execution failed");
            }
        };
        toolManager.register(tool);

        // executeTool re-throws the raw handler error to the caller
        await expect(
            toolManager.executeTool({
                tool,
                context: {} as TestContext,
                updateContext: async () => { },
                updateData: async () => { },
                history: [],
                data: {},
            })
        ).rejects.toThrow("Execution failed");
    });
});

describe("ToolManager Integration Tests", () => {
    test("should integrate with Agent addTool method", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });

        // Test that agent has addTool method
        expect(typeof agent.addTool).toBe("function");

        // Add tool using agent.addTool
        agent.addTool({
            id: "integration-tool",
            description: "Integration test tool",
            handler: async (context) => {
                return `Hello ${context.context?.userId}`;
            }
        });

        // Tool should be available in agent's tools
        const agentTools = agent.getTools();
        const addedTool = agentTools.find(t => t.id === "integration-tool");
        expect(addedTool).toBeDefined();
        expect(addedTool?.description).toBe("Integration test tool");
    });

    test("should support tool resolution across scopes", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        // Register tool in registry
        toolManager.register({
            id: "registry-tool",
            handler: async () => "registry result"
        });

        // Add tool to agent
        agent.addTool({
            id: "agent-tool",
            handler: async () => "agent result"
        });

        // Test finding tools from different scopes
        expect(toolManager.find("registry-tool")).toBeDefined();
        expect(toolManager.find("agent-tool")).toBeDefined();

        // Test getting all available tools
        const available = toolManager.getAvailable();
        expect(available.length).toBeGreaterThanOrEqual(2);
        expect(available.some(t => t.id === "registry-tool")).toBe(true);
        expect(available.some(t => t.id === "agent-tool")).toBe(true);
    });

    test("should handle tool ID references in steps", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        // Register a tool
        toolManager.register({
            id: "step-referenced-tool",
            handler: async () => "step result"
        });

        // Tool should be found in registry
        const foundTool = toolManager.find("step-referenced-tool");
        expect(foundTool).toBeDefined();
        expect(foundTool?.id).toBe("step-referenced-tool");

        // Available tools should include registered tools
        const available = toolManager.getAvailable();
        expect(available.some(t => t.id === "step-referenced-tool")).toBe(true);
    });
});

describe("ToolManager Performance Tests", () => {
    test("should handle large number of registered tools efficiently", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);
        const toolCount = 1000;

        // Register many tools
        const startTime = Date.now();
        for (let i = 0; i < toolCount; i++) {
            toolManager.register({
                id: `perf-tool-${i}`,
                handler: async () => `result-${i}`
            });
        }
        const registrationTime = Date.now() - startTime;

        // Test lookup performance
        const lookupStart = Date.now();
        for (let i = 0; i < 100; i++) {
            const randomId = `perf-tool-${Math.floor(Math.random() * toolCount)}`;
            toolManager.find(randomId);
        }
        const lookupTime = Date.now() - lookupStart;

        // Performance assertions (generous limits for CI environments)
        expect(registrationTime).toBeLessThan(5000); // 5 seconds for 1000 registrations
        expect(lookupTime).toBeLessThan(1000); // 1 second for 100 lookups
        expect(toolManager.getRegisteredIds()).toHaveLength(toolCount);
    });

    test("should efficiently get available tools with many scopes", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        // Register tools in registry
        for (let i = 0; i < 50; i++) {
            toolManager.register({
                id: `registry-${i}`,
                handler: async () => `registry-${i}`
            });
        }

        // Add tools to agent
        for (let i = 0; i < 50; i++) {
            agent.addTool({
                id: `agent-${i}`,
                handler: async () => `agent-${i}`
            });
        }

        const startTime = Date.now();
        const available = toolManager.getAvailable();
        const getAvailableTime = Date.now() - startTime;

        expect(getAvailableTime).toBeLessThan(100); // Should be very fast
        expect(available.length).toBeGreaterThanOrEqual(100);
    });

    test("should handle memory cleanup efficiently", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        // Create and register many tools
        for (let i = 0; i < 500; i++) {
            toolManager.register({
                id: `memory-tool-${i}`,
                handler: async () => `result-${i}`
            });
        }

        expect(toolManager.getRegisteredIds()).toHaveLength(500);

        // Clear registry
        toolManager.clearRegistry();

        expect(toolManager.getRegisteredIds()).toHaveLength(0);
        expect(toolManager.getAllRegistered().size).toBe(0);
    });
});

describe("ToolManager Advanced Features", () => {
    test("should support tool execution with context", async () => {
        const agent = new Agent<TestContext, TestData>({
            name: "test",
            provider,
            context: { userId: "test-123", role: "admin" }
        });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const tool = {
            id: "context-aware-tool",
            handler: async (context: ToolContext<TestContext, TestData>) => {
                return `User: ${context.context?.userId}, Role: ${context.context?.role}`;
            }
        };
        toolManager.register(tool);

        // Execute tool with context
        const result = await toolManager.executeTool({
            tool,
            context: { userId: "test-123", role: "admin" },
            updateContext: async () => { },
            updateData: async () => { },
            data: {},
            history: []
        });

        expect(result.success).toBe(true);
        expect(result.data).toBe("User: test-123, Role: admin");
    });

    test("should support bulk tool operations", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const tools = [
            { id: "bulk-1", handler: async () => "result-1" },
            { id: "bulk-2", handler: async () => "result-2" },
            { id: "bulk-3", handler: async () => "result-3" }
        ];

        // Register multiple tools at once
        const registeredTools = toolManager.registerMany(tools);

        expect(registeredTools).toHaveLength(3);
        expect(toolManager.isRegistered("bulk-1")).toBe(true);
        expect(toolManager.isRegistered("bulk-2")).toBe(true);
        expect(toolManager.isRegistered("bulk-3")).toBe(true);

        // Test getting tool count
        expect(toolManager.getToolCount()).toBeGreaterThanOrEqual(3);
    });

    test("should support tool unregistration", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        // Register a tool
        toolManager.register({
            id: "temporary-tool",
            handler: async () => "temp result"
        });

        expect(toolManager.isRegistered("temporary-tool")).toBe(true);

        // Unregister the tool
        const wasRemoved = toolManager.unregister("temporary-tool");
        expect(wasRemoved).toBe(true);
        expect(toolManager.isRegistered("temporary-tool")).toBe(false);

        // Try to unregister non-existent tool
        const wasNotRemoved = toolManager.unregister("non-existent");
        expect(wasNotRemoved).toBe(false);
    });

    test("should provide tool debugging information", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        // Register a tool
        toolManager.register({
            id: "debug-tool",
            name: "Debug Tool",
            description: "A tool for debugging",
            handler: async () => "debug result"
        });

        // Get tool info
        const info = toolManager.getToolInfo("debug-tool");
        expect(info.found).toBe(true);
        expect(info.tool?.id).toBe("debug-tool");
        expect(info.scope).toBe("registry");
        expect(info.metadata?.hasDescription).toBe(true);
        expect(info.metadata?.hasParameters).toBe(false);

        // Test non-existent tool
        const notFoundInfo = toolManager.getToolInfo("nonexistent");
        expect(notFoundInfo.found).toBe(false);
    });

    test("should validate tool references", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        // Register some tools
        toolManager.register({
            id: "existing-tool-1",
            handler: async () => "result1"
        });
        toolManager.register({
            id: "existing-tool-2",
            handler: async () => "result2"
        });

        // Validate tool references
        const validation = toolManager.validateToolReferences([
            "existing-tool-1",
            "existing-tool-2",
            "nonexistent-tool"
        ]);

        expect(validation.valid).toBe(false);
        expect(validation.found).toEqual(["existing-tool-1", "existing-tool-2"]);
        expect(validation.missing).toEqual(["nonexistent-tool"]);
        expect(validation.details).toHaveLength(3);
    });

    test("should provide system statistics", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        // Register tools
        toolManager.register({
            id: "stats-tool-1",
            handler: async () => "result1"
        });
        toolManager.register({
            id: "stats-tool-2",
            handler: async () => "result2"
        });

        // Add tool to agent (potential duplicate)
        agent.addTool({
            id: "agent-tool",
            handler: async () => "agent result"
        });

        const stats = toolManager.getStatistics();
        expect(stats.registeredTools).toBe(2);
        expect(stats.registeredToolIds).toContain("stats-tool-1");
        expect(stats.registeredToolIds).toContain("stats-tool-2");
        expect(stats.totalAvailable).toBeGreaterThanOrEqual(3);
    });

    test("should perform health checks", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        // Register valid tools
        toolManager.register({
            id: "healthy-tool",
            handler: async () => "result"
        });

        const health = toolManager.healthCheck();
        expect(health.healthy).toBe(true);
        expect(health.issues).toHaveLength(0);
        expect(health.statistics).toBeDefined();
        expect(health.statistics.registeredTools).toBeGreaterThanOrEqual(1);
    });
});


describe("ToolManager Transient Layer", () => {
    test("setTransientTools makes tools available for the turn", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const transientTool = {
            id: "transient-1",
            handler: async () => "transient result"
        };

        toolManager.setTransientTools([transientTool]);

        expect(toolManager.hasTransientTools()).toBe(true);
        const found = toolManager.find("transient-1");
        expect(found).toBe(transientTool);
    });

    test("clearTransientTools removes all transient tools", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        toolManager.setTransientTools([
            { id: "t1", handler: async () => "r1" },
            { id: "t2", handler: async () => "r2" },
        ]);

        expect(toolManager.hasTransientTools()).toBe(true);

        toolManager.clearTransientTools();

        expect(toolManager.hasTransientTools()).toBe(false);
        expect(toolManager.find("t1")).toBeUndefined();
        expect(toolManager.find("t2")).toBeUndefined();
    });

    test("transient tools take priority over step, flow, and agent tools", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        // Register at agent level
        agent.addTool({
            id: "shared-id",
            name: "agent-version",
            handler: async () => "agent"
        });

        // Set transient tool with same ID
        const transientVersion = {
            id: "shared-id",
            name: "transient-version",
            handler: async () => "transient"
        };
        toolManager.setTransientTools([transientVersion]);

        // find() should return the transient version
        const found = toolManager.find("shared-id");
        expect(found).toBe(transientVersion);
        expect(found?.name).toBe("transient-version");
    });

    test("transient tools appear in getAvailable with highest priority", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        agent.addTool({
            id: "agent-tool",
            handler: async () => "agent"
        });

        const transientTool = {
            id: "transient-only",
            handler: async () => "transient"
        };
        toolManager.setTransientTools([transientTool]);

        const available = toolManager.getAvailable();
        expect(available.some(t => t.id === "transient-only")).toBe(true);
        expect(available.some(t => t.id === "agent-tool")).toBe(true);
    });

    test("transient layer deduplicates by id with last-definition-wins", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const toolV1 = { id: "dedup-tool", name: "v1", handler: async () => "v1" };
        const toolV2 = { id: "dedup-tool", name: "v2", handler: async () => "v2" };

        // Last definition wins — toolV2 should override toolV1
        toolManager.setTransientTools([toolV1, toolV2]);

        const found = toolManager.find("dedup-tool");
        expect(found?.name).toBe("v2");
    });

    test("transient tools are not available after clearTransientTools (try/finally pattern)", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const transientTool = {
            id: "one-turn-tool",
            handler: async () => "one turn"
        };

        // Simulate try/finally guard pattern
        toolManager.setTransientTools([transientTool]);
        try {
            // During "turn" — tool is available
            expect(toolManager.find("one-turn-tool")).toBe(transientTool);
        } finally {
            toolManager.clearTransientTools();
        }

        // After "turn" — tool is gone
        expect(toolManager.find("one-turn-tool")).toBeUndefined();
        expect(toolManager.hasTransientTools()).toBe(false);
    });

    test("setTransientTools replaces previous transient tools", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        toolManager.setTransientTools([
            { id: "first-turn-tool", handler: async () => "first" }
        ]);
        expect(toolManager.find("first-turn-tool")).toBeDefined();

        // Next turn sets different tools — previous ones are gone
        toolManager.setTransientTools([
            { id: "second-turn-tool", handler: async () => "second" }
        ]);
        expect(toolManager.find("first-turn-tool")).toBeUndefined();
        expect(toolManager.find("second-turn-tool")).toBeDefined();
    });

    test("transient tools override step tools with same id in getAvailable", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        // Create a mock step with a tool
        const stepTool = { id: "overlap-tool", name: "step-version", handler: async () => "step" };
        const mockStep = { tools: [stepTool] } as any;

        // Set a transient tool with same id
        const transientTool = { id: "overlap-tool", name: "transient-version", handler: async () => "transient" };
        toolManager.setTransientTools([transientTool]);

        // getAvailable with step context — transient should win
        const available = toolManager.getAvailable(undefined, mockStep);
        const resolved = available.find(t => t.id === "overlap-tool");
        expect(resolved?.name).toBe("transient-version");
    });

    test("empty array to setTransientTools clears any existing tools", () => {
        const agent = new Agent<TestContext, TestData>({ name: "test", provider });
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        toolManager.setTransientTools([
            { id: "temp", handler: async () => "temp" }
        ]);
        expect(toolManager.hasTransientTools()).toBe(true);

        toolManager.setTransientTools([]);
        expect(toolManager.hasTransientTools()).toBe(false);
    });
});
