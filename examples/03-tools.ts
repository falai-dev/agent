/**
 * Tools — defining tools, imperative dispatch, declarative directives, and metadata.
 * Teaches: Tool, ctx.dispatch, ToolResult.directive, isReadOnly.
 * Read next: docs/reference/tool.md
 */

import {
    createAgent,
    GeminiProvider,
    createSession,
    type Tool,
    type ToolResult,
    type Directive,
} from "@falai/agent";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AppContext { userId: string }

interface AppData {
    city: string;
    checkIn: string;
    checkOut: string;
    confirmationId: string;
}

// ─── Tool 1: Read-only lookup (metadata: isReadOnly) ─────────────────────────

const checkAvailability: Tool<AppContext, AppData> = {
    id: "check_availability",
    description: "Check hotel room availability for the given dates.",
    parameters: {
        type: "object",
        properties: {
            city: { type: "string" },
            checkIn: { type: "string" },
            checkOut: { type: "string" },
        },
        required: ["city", "checkIn", "checkOut"],
    },
    // Metadata: this tool only reads data — safe to run concurrently.
    isReadOnly: () => true,

    async handler(_ctx, args) {
        const { city, checkIn, checkOut } = args as Record<string, string>;
        const available = city !== "atlantis";
        return { data: { city, checkIn, checkOut, available } };
    },
};

// ─── Tool 2: Imperative dispatch (ctx.dispatch) ──────────────────────────────

const bookRoom: Tool<AppContext, AppData> = {
    id: "book_room",
    description: "Book a hotel room. Requires availability check first.",
    parameters: {
        type: "object",
        properties: {
            city: { type: "string" },
            checkIn: { type: "string" },
            checkOut: { type: "string" },
        },
        required: ["city", "checkIn", "checkOut"],
    },

    async handler(ctx, args) {
        const { city } = args as Record<string, string>;

        // Imperative: emit directives mid-handler via ctx.dispatch
        ctx.dispatch({ dataUpdate: { confirmationId: `CONF-${Date.now()}` } });
        ctx.dispatch({ complete: true });

        return { data: { booked: true, city } };
    },
};

// ─── Tool 3: Declarative directive via ToolResult.directive ──────────────────

const cancelBooking: Tool<AppContext, AppData> = {
    id: "cancel_booking",
    description: "Cancel the current booking and reset the flow.",

    async handler(ctx): Promise<ToolResult<{ cancelled: boolean }, AppContext, AppData>> {
        if (!ctx.getField("confirmationId")) {
            return { success: false, error: "No active booking to cancel." };
        }
        // Declarative: return a directive as part of the tool result
        const directive: Directive<AppContext, AppData> = {
            reset: { clearData: true, reason: "Booking cancelled by user" },
            reply: "Your booking has been cancelled. Let me know if you'd like to start over.",
        };
        return { data: { cancelled: true }, directive };
    },
};

// ─── Agent ───────────────────────────────────────────────────────────────────

const agent = createAgent<AppContext, AppData>({
    name: "BookingAgent",
    provider: new GeminiProvider({
        apiKey: process.env.GEMINI_API_KEY!,
        model: "models/gemini-2.5-flash",
    }),
    schema: {
        type: "object",
        properties: {
            city: { type: "string" },
            checkIn: { type: "string" },
            checkOut: { type: "string" },
            confirmationId: { type: "string" },
        },
    },
    tools: [checkAvailability, bookRoom, cancelBooking],
    flows: [
        {
            title: "Book a Room",
            when: "User wants to book a hotel room",
            requiredFields: ["city", "checkIn", "checkOut"],
            steps: [
                { id: "gather", prompt: "Ask for city, check-in, and check-out dates.", collect: ["city", "checkIn", "checkOut"] },
                { id: "confirm", prompt: "Confirm the booking details and use the book_room tool." },
            ],
        },
    ],
});

// ─── Run ─────────────────────────────────────────────────────────────────────

const session = createSession<AppData>("tools-demo");

const response = await agent.respond({
    history: [{ role: "user", content: "Book me a room in Tokyo from Jan 5 to Jan 8" }],
    session,
});

console.log(response.message);
