/**
 * Server Session Management Example
 *
 * This example demonstrates how to use automatic session management
 * in a server environment where each request creates a new Agent instance.
 *
 * Key concepts:
 * - Stateless server design with automatic session management
 * - Session continuity across requests
 * - Simple message-based API
 * - Automatic persistence
 */

import {
    Agent,
    OpenAIProvider,
    MemoryAdapter,
    type Tool,
} from "../../src/index";

// Define data types for our booking system
interface BookingData {
    customerName: string;
    hotelName: string;
    checkInDate: string;
    checkOutDate: string;
    guests: number;
    roomType?: "standard" | "deluxe" | "suite";
    specialRequests?: string;
    bookingId?: string;
}

// Booking confirmation tool
const confirmBooking: Tool<unknown, BookingData, [], string> = {
    id: "confirm_booking",
    description: "Confirm the hotel booking with all details",
    parameters: {
        type: "object",
        properties: {},
    },
    handler: ({ data }) => {
        const bookingData = data as Partial<BookingData>;
        const bookingId = `BK-${Date.now()}`;

        console.log(`📋 Confirming booking ${bookingId} for ${bookingData.customerName}`);
        console.log(`🏨 Hotel: ${bookingData.hotelName}`);
        console.log(`📅 Dates: ${bookingData.checkInDate} to ${bookingData.checkOutDate}`);
        console.log(`👥 Guests: ${bookingData.guests}`);

        return {
            data: `Booking confirmed! Your booking ID is ${bookingId}. You'll receive a confirmation email shortly.`,
            dataUpdate: {
                bookingId,
            },
        };
    },
};

// Define booking schema
const bookingSchema = {
    type: "object",
    properties: {
        customerName: { type: "string" },
        hotelName: { type: "string" },
        checkInDate: { type: "string" },
        checkOutDate: { type: "string" },
        guests: { type: "number", minimum: 1, maximum: 10 },
        roomType: { type: "string", enum: ["standard", "deluxe", "suite"] },
        specialRequests: { type: "string" },
        bookingId: { type: "string" },
    },
    required: ["customerName", "hotelName", "checkInDate", "checkOutDate", "guests"],
};

// Function to create agent for each request (server pattern)
function createBookingAgent(sessionId?: string) {
    return new Agent<unknown, BookingData>({
        name: "Hotel Booking Assistant",
        description: "Help customers book hotel rooms",
        provider: new OpenAIProvider({
            apiKey: process.env.OPENAI_API_KEY!,
            model: "gpt-4",
        }),
        // NEW: Agent-level schema
        schema: bookingSchema,
        persistence: {
            adapter: new MemoryAdapter(), // In production: RedisAdapter, PrismaAdapter, etc.
            autoSave: true,
        },
        sessionId, // Automatically loads or creates this session
        routes: [
            {
                title: "Hotel Booking",
                description: "Collect booking details and confirm reservation",
                conditions: ["User wants to book a hotel room"],
                // NEW: Required fields for route completion
                requiredFields: ["customerName", "hotelName", "checkInDate", "checkOutDate", "guests"],
                // NEW: Optional fields that enhance the experience
                optionalFields: ["roomType", "specialRequests", "bookingId"],
                steps: [
                    {
                        id: "ask_name",
                        description: "Ask for customer name",
                        prompt: "Hi! I'd be happy to help you book a hotel room. What's your name?",
                        collect: ["customerName"],
                        skipIf: (data: Partial<BookingData>) => !!data.customerName,
                    },
                    {
                        id: "ask_hotel",
                        description: "Ask for hotel preference",
                        prompt: "Which hotel would you like to book?",
                        collect: ["hotelName"],
                        requires: ["customerName"],
                        skipIf: (data: Partial<BookingData>) => !!data.hotelName,
                    },
                    {
                        id: "ask_dates",
                        description: "Ask for check-in and check-out dates",
                        prompt: "What are your check-in and check-out dates?",
                        collect: ["checkInDate", "checkOutDate"],
                        requires: ["customerName", "hotelName"],
                        skipIf: (data: Partial<BookingData>) => !!data.checkInDate && !!data.checkOutDate,
                    },
                    {
                        id: "ask_guests",
                        description: "Ask for number of guests",
                        prompt: "How many guests will be staying?",
                        collect: ["guests"],
                        requires: ["customerName", "hotelName", "checkInDate", "checkOutDate"],
                        skipIf: (data: Partial<BookingData>) => data.guests !== undefined,
                    },
                    {
                        id: "ask_room_type",
                        description: "Ask for room type preference",
                        prompt: "What type of room would you prefer? (standard, deluxe, or suite)",
                        collect: ["roomType"],
                        requires: ["customerName", "hotelName", "checkInDate", "checkOutDate", "guests"],
                        skipIf: (data: Partial<BookingData>) => !!data.roomType,
                    },
                    {
                        id: "ask_special_requests",
                        description: "Ask for any special requests",
                        prompt: "Do you have any special requests for your stay?",
                        collect: ["specialRequests"],
                        requires: ["customerName", "hotelName", "checkInDate", "checkOutDate", "guests"],
                        skipIf: (data: Partial<BookingData>) => data.specialRequests !== undefined,
                    },
                    {
                        id: "confirm_booking",
                        description: "Confirm the booking",
                        prompt: "Perfect! Let me confirm your booking details.",
                        tools: [confirmBooking],
                        requires: ["customerName", "hotelName", "checkInDate", "checkOutDate", "guests"],
                    },
                ],
            },
        ],
    });
}

// Simulate server endpoints
interface ChatRequest {
    sessionId?: string;
    message: string;
}

interface ChatResponse {
    message: string;
    sessionId: string;
    isComplete: boolean;
    data?: Partial<BookingData>;
}

// Simulate POST /chat endpoint
async function handleChatRequest(request: ChatRequest): Promise<ChatResponse> {
    console.log(`📨 Incoming request: sessionId=${request.sessionId}, message="${request.message}"`);

    // Create new agent instance for this request (stateless server pattern)
    const agent = createBookingAgent(request.sessionId);

    // Process the message - session automatically managed
    const response = await agent.chat(request.message);

    console.log(`📤 Response: sessionId=${agent.session.id}, message="${response.message}"`);

    return {
        message: response.message,
        sessionId: agent.session.id!,
        isComplete: response.isRouteComplete!,
        data: agent.session.getData(),
    };
}

// Demonstrate server session management
async function demonstrateServerSessionManagement() {
    console.log("=== Server Session Management Demo ===\n");
    console.log("Simulating a stateless server where each request creates a new Agent instance\n");

    // Request 1: Start new conversation (no sessionId)
    console.log("🔄 Request 1: New conversation");
    const response1 = await handleChatRequest({
        message: "Hi, I'm John and I want to book a room at the Grand Hotel",
    });

    console.log("✅ Response 1:");
    console.log(`   Message: ${response1.message}`);
    console.log(`   Session ID: ${response1.sessionId}`);
    console.log(`   Data: ${JSON.stringify(response1.data, null, 2)}`);
    console.log();

    // Request 2: Continue conversation (with sessionId)
    console.log("🔄 Request 2: Continue conversation");
    const response2 = await handleChatRequest({
        sessionId: response1.sessionId, // Use session from previous request
        message: "Check-in December 15th, check-out December 18th, for 2 guests",
    });

    console.log("✅ Response 2:");
    console.log(`   Message: ${response2.message}`);
    console.log(`   Session ID: ${response2.sessionId}`);
    console.log(`   Data: ${JSON.stringify(response2.data, null, 2)}`);
    console.log();

    // Request 3: Complete booking
    console.log("🔄 Request 3: Complete booking");
    const response3 = await handleChatRequest({
        sessionId: response2.sessionId,
        message: "Deluxe room please, and I need a late check-out if possible",
    });

    console.log("✅ Response 3:");
    console.log(`   Message: ${response3.message}`);
    console.log(`   Session ID: ${response3.sessionId}`);
    console.log(`   Complete: ${response3.isComplete}`);
    console.log(`   Data: ${JSON.stringify(response3.data, null, 2)}`);
    console.log();

    // Simulate user returning later with same sessionId
    console.log("🔄 Request 4: User returns later (session restoration)");
    const response4 = await handleChatRequest({
        sessionId: response3.sessionId,
        message: "Can I modify my booking?",
    });

    console.log("✅ Response 4:");
    console.log(`   Message: ${response4.message}`);
    console.log(`   Session ID: ${response4.sessionId}`);
    console.log(`   Data: ${JSON.stringify(response4.data, null, 2)}`);
}

// Demonstrate session isolation between different users
async function demonstrateSessionIsolation() {
    console.log("\n=== Session Isolation Demo ===\n");
    console.log("Demonstrating that different users have isolated sessions\n");

    // User A starts booking
    console.log("👤 User A: Starting booking");
    const userA1 = await handleChatRequest({
        message: "Hi, I'm Alice and I want to book the Luxury Resort",
    });
    console.log(`   User A Session: ${userA1.sessionId}`);
    console.log(`   User A Data: ${JSON.stringify(userA1.data, null, 2)}`);
    console.log();

    // User B starts booking (different session)
    console.log("👤 User B: Starting booking");
    const userB1 = await handleChatRequest({
        message: "Hello, I'm Bob and I need a room at Budget Inn",
    });
    console.log(`   User B Session: ${userB1.sessionId}`);
    console.log(`   User B Data: ${JSON.stringify(userB1.data, null, 2)}`);
    console.log();

    // User A continues (session isolated)
    console.log("👤 User A: Continuing booking");
    const userA2 = await handleChatRequest({
        sessionId: userA1.sessionId,
        message: "January 20th to 25th for 4 guests",
    });
    console.log(`   User A Data: ${JSON.stringify(userA2.data, null, 2)}`);
    console.log();

    // User B continues (different session, isolated data)
    console.log("👤 User B: Continuing booking");
    const userB2 = await handleChatRequest({
        sessionId: userB1.sessionId,
        message: "March 1st to 3rd for 1 guest",
    });
    console.log(`   User B Data: ${JSON.stringify(userB2.data, null, 2)}`);
    console.log();

    console.log("✅ Sessions are properly isolated - each user has their own data!");
}

// Run demonstrations
async function main() {
    try {
        await demonstrateServerSessionManagement();
        await demonstrateSessionIsolation();
    } catch (error) {
        console.error("Error:", error);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}