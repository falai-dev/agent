/**
 * Route Transitions Example
 *
 * Demonstrates how to use onComplete to automatically transition between routes
 * after a route completes, enabling flows like:
 * - Post-booking feedback collection
 * - Upsell after purchase
 * - Satisfaction surveys after support
 * 
 * NEW: Enhanced with flexible ConditionTemplate patterns:
 * - Mixed route conditions: ["AI context", (ctx) => programmatic_check]
 * - Route skipIf examples: Dynamic route exclusion based on state
 * - Step skipIf examples: Enhanced conditional step skipping
 * - AI context strings in action for better routing decisions
 */

import {
  Agent,
  GeminiProvider,
  History,
  type SessionState,
} from "../../src/index";

// Type definitions for our unified data collection
interface UnifiedBookingData {
  // Booking fields
  hotelName: string;
  date: string;
  guests: number;
  // Feedback fields
  rating: number;
  comments?: string;
}

async function main() {
  // Define unified schema for both booking and feedback data
  const unifiedSchema = {
    type: "object",
    properties: {
      // Booking fields
      hotelName: { type: "string" },
      date: { type: "string" },
      guests: { type: "number" },
      // Feedback fields
      rating: { type: "number", minimum: 1, maximum: 5 },
      comments: { type: "string" },
    },
    required: ["hotelName", "date", "guests"], // Only booking fields are required initially
  };

  // Create agent with unified schema
  const agent = new Agent<any, UnifiedBookingData>({
    name: "HotelBot",
    description: "A hotel booking assistant with feedback collection",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    debug: true,
    schema: unifiedSchema,
  });

  // Route 1: Hotel Booking with automatic transition to feedback
  agent.createRoute({
    title: "Book Hotel",
    description: "Collects hotel booking information",
    // Mixed condition: AI context + programmatic validation
    when: [
      "User wants to book a hotel",
      (ctx) => {
        const event = ctx.history?.[ctx.history.length - 1]
        if(event && "content" in event){
          const message = (event.content as string).toLocaleLowerCase() || '';
          return message.includes('book') || message.includes('hotel') || message.includes('reservation');
        }
        return false;
      }
    ],
    // Skip if user already has a booking
    skipIf: [
      "user already has an active booking",
      (ctx) => !!ctx.data?.hotelName && !!ctx.data?.date
    ],
    // NEW: Required fields for route completion
    requiredFields: ["hotelName", "date", "guests"],
    // Sequential steps for booking flow
    steps: [
      {
        id: "ask_hotel",
        description: "Ask for hotel preference",
        prompt: "Which hotel would you like to book?",
        collect: ["hotelName"],
        // String-only skipIf for AI context
        skipIf: "hotel already selected",
      },
      {
        id: "ask_date",
        description: "Ask for booking date",
        prompt: "What date would you like to book for?",
        collect: ["date"],
        requires: ["hotelName"],
        // Function-only skipIf for programmatic check
        skipIf: (data) => !!data.context.date,
      },
      {
        id: "ask_guests",
        description: "Ask for number of guests",
        prompt: "How many guests will be staying?",
        collect: ["guests"],
        requires: ["hotelName", "date"],
        // Mixed skipIf: AI context + programmatic logic
        skipIf: [
          "guest count already provided",
          (data) => data.context.guests !== undefined
        ],
      },
      {
        id: "confirm_booking",
        description: "Confirm the booking",
        prompt:
          "Confirm the booking with a summary of the hotel, date, and number of guests. Be enthusiastic!",
        requires: ["hotelName", "date", "guests"],
      },
    ],
    // Automatic transition to feedback collection when booking completes
    onComplete: "Collect Feedback",
  });

  // Route 2: Feedback Collection
  agent.createRoute({
    title: "Collect Feedback",
    description: "Collects user feedback after booking",
    // Function-only condition for programmatic logic
    when: (ctx) => {
      // Only activate if we have booking data but no feedback yet
      return !!ctx.data?.hotelName && ctx.data?.rating === undefined;
    },
    // Skip if feedback already collected
    skipIf: [
      "feedback already provided",
      (ctx) => ctx.data?.rating !== undefined
    ],
    // NEW: Required fields for route completion
    requiredFields: ["rating"],
    // NEW: Optional fields that enhance the experience
    optionalFields: ["comments"],
    // Sequential steps for feedback collection
    steps: [
      {
        id: "ask_rating",
        description: "Ask for rating",
        prompt: "How would you rate your booking experience from 1 to 5?",
        collect: ["rating"],
        // Mixed skipIf: AI context + programmatic check
        skipIf: [
          "rating already provided",
          (data) => data.context.rating !== undefined
        ],
      },
      {
        id: "ask_comments",
        description: "Ask for comments",
        prompt:
          "Would you like to share any additional comments about your experience?",
        collect: ["comments"],
      },
      {
        id: "thank_feedback",
        description: "Thank user for feedback",
        prompt:
          "Thank the user warmly for their feedback and let them know their input is valuable",
        requires: ["rating"],
      },
    ],
    // End conversation after feedback is collected
    onComplete: undefined, // No transition - conversation ends
  });

  console.log("\n=== Route Transitions Example ===\n");

  // Conversation 1: User provides all booking info at once
  let session: SessionState | undefined;
  let history: History = [
    {
      role: "user" as const,
      content: "I want to book the Grand Hotel for 2 guests on December 25th",
      name: "Alice",
    },
  ];

  console.log("User:", history[0].content);

  // First response - should handle booking
  const response1 = await agent.respond({ history, session });
  console.log("\nBot:", response1.message);
  console.log("Route complete?", response1.isRouteComplete);
  console.log(
    "Pending transition?",
    response1.session?.pendingTransition?.targetRouteId
  );
  console.log("Collected data:", response1.session?.data);

  session = response1.session;
  history = [
    ...history,
    {
      role: "assistant" as const,
      content: response1.message,
    },
  ] as History;

  // Second response - should auto-transition to a feedback route
  history = [
    ...history,
    {
      role: "user" as const,
      content: "Yes, please proceed!",
      name: "Alice",
    },
  ];
  console.log("\nUser:", "Yes, please proceed!");

  const response2 = await agent.respond({ history, session });
  console.log("\nBot:", response2.message);
  console.log("Current route:", response2.session?.currentRoute?.title);
  console.log("Route complete?", response2.isRouteComplete);

  session = response2.session;
  history = [
    ...history,
    {
      role: "assistant" as const,
      content: response2.message,
    },
  ];

  // Third response - provide rating
  history = [
    ...history,
    {
      role: "user" as const,
      content: "I'd rate it 5 stars! The process was very smooth.",
      name: "Alice",
    },
  ];
  console.log("\nUser:", "I'd rate it 5 stars! The process was very smooth.");

  const response3 = await agent.respond({ history, session });
  console.log("\nBot:", response3.message);
  console.log("Current route:", response3.session?.currentRoute?.title);
  console.log("Collected data:", response3.session?.data);
  console.log("Route complete?", response3.isRouteComplete);

  console.log("\n=== Manual Transition Example ===\n");

  // Demonstrate manual transition using agent.nextStepRoute()
  let session2: SessionState | undefined;
  let history2: History = [
    {
      role: "user" as const,
      content:
        "I want to book the Sunset Resort for 4 people on New Year's Eve",
      name: "Bob",
    },
  ];

  console.log("User:", history2[0].content);

  const manualResponse = await agent.respond({
    history: history2,
    session: session2,
  });
  console.log("\nBot:", manualResponse.message);
  console.log("Route complete?", manualResponse.isRouteComplete);

  if (manualResponse.isRouteComplete && manualResponse.session) {
    // Manually trigger transition instead of auto-transition
    console.log("\n[Manually transitioning to feedback route...]");
    session2 = await agent.nextStepRoute(
      "Collect Feedback",
      manualResponse.session,
      "if booking was successful"
    );
    console.log(
      "Pending transition set:",
      session2.pendingTransition?.targetRouteId
    );

    history2 = [
      ...history2,
      {
        role: "assistant" as const,
        content: manualResponse.message,
      },
      {
        role: "user" as const,
        content: "Great!",
        name: "Bob",
      },
    ];

    const feedbackResponse = await agent.respond({
      history: history2,
      session: session2,
    });
    console.log("\nBot:", feedbackResponse.message);
    console.log(
      "Current route:",
      feedbackResponse.session?.currentRoute?.title
    );
  }

  console.log("\n=== Done ===\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
