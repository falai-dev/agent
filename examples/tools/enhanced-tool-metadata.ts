/**
 * Enhanced Tool Metadata Example
 *
 * Demonstrates the EnhancedTool interface with rich metadata for concurrency
 * control, input validation, permission gating, and result size budgeting.
 *
 * Key concepts:
 * - `isConcurrencySafe` — classify tools for parallel vs serial execution
 * - `validateInput` — reject bad inputs before the handler runs
 * - `checkPermissions` — gate execution behind authorization checks
 * - `maxResultSizeChars` — cap result size to prevent context overflow
 * - `interruptBehavior` — control abort signal handling ('cancel' vs 'block')
 * - Backward compatibility: plain `Tool` objects work without any metadata
 */

import {
    Agent,
    GeminiProvider,
    type EnhancedTool,
    type Tool,
    type ToolContext,
} from "../../src/index";

// --- Context type for permission checks ---

interface AppContext {
    userRole: "admin" | "editor" | "viewer";
    userId: string;
}

// --- 1. Read-only tool with concurrency metadata ---

const fetchUserTool: EnhancedTool<AppContext> = {
    id: "fetch_user",
    name: "Fetch User",
    description: "Fetch user profile by ID",
    parameters: {
        type: "object",
        properties: { userId: { type: "string" } },
        required: ["userId"],
    },
    handler: async (_ctx, args) => {
        const userId = args?.userId as string;
        return { data: `User ${userId}: Alice (admin)`, success: true };
    },

    // Concurrency metadata — safe to run alongside other reads
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isDestructive: () => false,
    interruptBehavior: () => "cancel",

    // Cap result size to 10k chars
    maxResultSizeChars: 10_000,
};

// --- 2. Write tool with validation and permissions ---

const deleteResourceTool: EnhancedTool<AppContext> = {
    id: "delete_resource",
    name: "Delete Resource",
    description: "Permanently delete a resource",
    parameters: {
        type: "object",
        properties: { resourceId: { type: "string" } },
        required: ["resourceId"],
    },
    handler: async (_ctx, args) => {
        const id = args?.resourceId as string;
        return { data: `Resource ${id} deleted`, success: true };
    },

    // Not concurrency-safe — must run exclusively
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isDestructive: () => true,
    interruptBehavior: () => "block", // don't abort mid-delete

    maxResultSizeChars: 500,

    // Input validation — runs before handler
    validateInput: (input) => {
        const id = input.resourceId;
        if (!id || typeof id !== "string" || id.trim().length === 0) {
            return { valid: false, error: "resourceId must be a non-empty string" };
        }
        // Suggest correction for common prefix mistake
        if (typeof id === "string" && !id.startsWith("res_")) {
            return {
                valid: false,
                error: "resourceId must start with 'res_'",
                correctedInput: { resourceId: `res_${id}` },
            };
        }
        return { valid: true };
    },

    // Permission check — runs before handler
    checkPermissions: (_input, ctx) => {
        if (ctx.context.userRole !== "admin") {
            return {
                allowed: false,
                reason: "Only admins can delete resources",
                canOverride: false,
            };
        }
        return { allowed: true };
    },
};

// --- 3. Tool with input-dependent concurrency ---

const queryDatabaseTool: EnhancedTool<AppContext> = {
    id: "query_database",
    name: "Query Database",
    description: "Run a database query (SELECT is concurrent-safe, mutations are not)",
    parameters: {
        type: "object",
        properties: {
            sql: { type: "string" },
            readonly: { type: "boolean" },
        },
        required: ["sql"],
    },
    handler: async (_ctx, args) => {
        const sql = args?.sql as string;
        return { data: `Query result for: ${sql}`, success: true };
    },

    // Concurrency depends on the query type
    isConcurrencySafe: (input) => input?.readonly === true,
    isReadOnly: (input) => input?.readonly === true,
    isDestructive: (input) => {
        const sql = (input?.sql as string)?.toUpperCase() ?? "";
        return sql.includes("DROP") || sql.includes("DELETE") || sql.includes("TRUNCATE");
    },
    interruptBehavior: () => "block",

    // Validate SQL isn't empty
    validateInput: (input) => {
        if (!input.sql || typeof input.sql !== "string") {
            return { valid: false, error: "sql must be a non-empty string" };
        }
        return { valid: true };
    },

    // Large query results get truncated
    maxResultSizeChars: 50_000,
};

// --- 4. Plain Tool (backward compatible, no metadata) ---

const echoTool: Tool<AppContext> = {
    id: "echo",
    name: "Echo",
    description: "Echo back the input (plain Tool, no EnhancedTool metadata)",
    parameters: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
    },
    handler: async (_ctx, args) => {
        return { data: args?.message as string, success: true };
    },
    // No isConcurrencySafe, validateInput, checkPermissions, etc.
    // Defaults: isConcurrencySafe → false, interruptBehavior → 'block'
};

// --- Demo functions ---

function demonstrateMetadata() {
    console.log("=== EnhancedTool Metadata ===\n");

    const tools = [fetchUserTool, deleteResourceTool, queryDatabaseTool, echoTool];

    for (const tool of tools) {
        const enhanced = tool as EnhancedTool;
        console.log(`${tool.id}:`);
        console.log(`  concurrencySafe:  ${enhanced.isConcurrencySafe?.() ?? "default (false)"}`);
        console.log(`  readOnly:         ${enhanced.isReadOnly?.() ?? "default (false)"}`);
        console.log(`  destructive:      ${enhanced.isDestructive?.() ?? "default (false)"}`);
        console.log(`  interruptBehavior: ${enhanced.interruptBehavior?.() ?? "default (block)"}`);
        console.log(`  maxResultSizeChars: ${enhanced.maxResultSizeChars ?? "none"}`);
        console.log(`  hasValidateInput: ${!!enhanced.validateInput}`);
        console.log(`  hasCheckPermissions: ${!!enhanced.checkPermissions}`);
        console.log();
    }
}

function demonstrateInputDependentConcurrency() {
    console.log("=== Input-Dependent Concurrency ===\n");

    const selectInput = { sql: "SELECT * FROM users", readonly: true };
    const insertInput = { sql: "INSERT INTO users VALUES (...)", readonly: false };
    const dropInput = { sql: "DROP TABLE users", readonly: false };

    console.log(`SELECT query: concurrencySafe=${queryDatabaseTool.isConcurrencySafe!(selectInput)}`);
    console.log(`INSERT query: concurrencySafe=${queryDatabaseTool.isConcurrencySafe!(insertInput)}`);
    console.log(`DROP query:   destructive=${queryDatabaseTool.isDestructive!(dropInput)}`);
    console.log();
}

async function demonstrateValidation() {
    console.log("=== Input Validation ===\n");

    const cases = [
        { label: "valid ID", input: { resourceId: "res_123" } },
        { label: "missing prefix", input: { resourceId: "123" } },
        { label: "empty string", input: { resourceId: "" } },
    ];

    for (const { label, input } of cases) {
        const result = deleteResourceTool.validateInput!(input, {} as any);
        const resolved = result instanceof Promise ? await result : result;
        console.log(`  ${label}: valid=${resolved.valid}${resolved.error ? `, error="${resolved.error}"` : ""}${resolved.correctedInput ? `, corrected=${JSON.stringify(resolved.correctedInput)}` : ""}`);
    }
    console.log();
}

async function demonstratePermissions() {
    console.log("=== Permission Gating ===\n");

    const roles: Array<"admin" | "editor" | "viewer"> = ["admin", "editor", "viewer"];

    for (const role of roles) {
        const mockCtx = { context: { userRole: role, userId: "u1" } } as ToolContext<AppContext>;
        const result = deleteResourceTool.checkPermissions!({ resourceId: "res_1" }, mockCtx);
        const resolved = result instanceof Promise ? await result : result;
        console.log(`  role=${role}: allowed=${resolved.allowed}${resolved.reason ? `, reason="${resolved.reason}"` : ""}`);
    }
    console.log();
}

function demonstrateAgentRegistration() {
    console.log("=== Agent Registration ===\n");

    const agent = new Agent<AppContext>({
        name: "MetadataDemo",
        description: "Demonstrates EnhancedTool metadata",
        provider: new GeminiProvider({
            apiKey: process.env.GEMINI_API_KEY || "demo-key",
            model: "models/gemini-2.5-flash",
        }),
        context: { userRole: "admin", userId: "u1" },
        // Mix of EnhancedTool and plain Tool — both accepted seamlessly
        tools: [fetchUserTool, deleteResourceTool, queryDatabaseTool, echoTool],
    });

    console.log("Registered tools:");
    for (const t of agent.getTools()) {
        console.log(`  - ${t.id}`);
    }
    console.log("\nPlain Tool objects work alongside EnhancedTool without changes.");
}

async function main() {
    demonstrateMetadata();
    demonstrateInputDependentConcurrency();
    await demonstrateValidation();
    await demonstratePermissions();
    demonstrateAgentRegistration();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export { main };
