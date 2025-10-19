/**
 * Route Transitions Example
 *
 * Demonstrates how to use onComplete to automatically transition between routes
 * after a route completes, enabling flows like:
 * - Post-booking feedback collection
 * - Upsell after purchase
 * - Satisfaction surveys after support
 */

import {
  Agent,
  GeminiProvider,
  History,
  type SessionState,
} from "../../src/index";

// Type definitions for our booking data
interface BookingData {
  hotelName: string;
  date: string;
  guests: number;
}

interface FeedbackData {
  rating: number;
  comments?: string;
}

async function main() {
  // Create agent
  const agent = new Agent({
    name: "HotelBot",
    description: "A hotel booking assistant with feedback collection",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    debug: true,
  });

  // Route 1: Hotel Booking with automatic transition to feedback
  agent.createRoute<BookingData>({
    title: "Book Hotel",
    description: "Collects hotel booking information",
    conditions: ["User wants to book a hotel"],
    schema: {
      type: "object",
      properties: {
        hotelName: { type: "string" },
        date: { type: "string" },
        guests: { type: "number" },
      },
      required: ["hotelName", "date", "guests"],
    },
    // Sequential steps for booking flow
    steps: [
      {
        id: "ask_hotel",
        description: "Ask for hotel preference",
        prompt: "Which hotel would you like to book?",
        collect: ["hotelName"],
        skipIf: (data: Partial<BookingData>) => !!data.hotelName,
      },
      {
        id: "ask_date",
        description: "Ask for booking date",
        prompt: "What date would you like to book for?",
        collect: ["date"],
        requires: ["hotelName"],
        skipIf: (data: Partial<BookingData>) => !!data.date,
      },
      {
        id: "ask_guests",
        description: "Ask for number of guests",
        prompt: "How many guests will be staying?",
        collect: ["guests"],
        requires: ["hotelName", "date"],
        skipIf: (data: Partial<BookingData>) => data.guests !== undefined,
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
  agent.createRoute<FeedbackData>({
    title: "Collect Feedback",
    description: "Collects user feedback after booking",
    conditions: ["User wants to provide feedback"],
    schema: {
      type: "object",
      properties: {
        rating: { type: "number", minimum: 1, maximum: 5 },
        comments: { type: "string" },
      },
      required: ["rating"],
    },
    // Sequential steps for feedback collection
    steps: [
      {
        id: "ask_rating",
        description: "Ask for rating",
        prompt: "How would you rate your booking experience from 1 to 5?",
        collect: ["rating"],
        skipIf: (data: Partial<FeedbackData>) => data.rating !== undefined,
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
  console.log("Data booking data:", response1.session?.data);

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
  console.log("Data feedback data:", response3.session?.data);
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
