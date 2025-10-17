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
  createMessageEvent,
  EventSource,
  END_ROUTE,
  type SessionState,
} from "../src/index";

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
      model: "models/gemini-2.0-flash-exp",
    }),
    debug: true,
  });

  // Route 1: Hotel Booking
  const bookingRoute = agent.createRoute<BookingData>({
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
    // Configure completion message at route level
    endStep: {
      instructions:
        "Confirm the booking with a summary of the hotel, date, and number of guests. Be enthusiastic!",
    },
    // Option 1: Simple string
    onComplete: "Collect Feedback",
    // Option 2: Object with condition
    // onComplete: {
    //   nextStep: "Collect Feedback",
    //   condition: "if booking was successful"
    // },
    // Option 3: Function with logic
    // onComplete: (session) => {
    //   if (session.data?.guests && session.data.guests > 5) {
    //     return "VIP Feedback"; // Different feedback for large groups
    //   }
    //   return "Collect Feedback";
    // },
  });

  const askHotel = bookingRoute.initialStep.nextStep({
    instructions: "Ask which hotel they want to book",
    collect: ["hotelName"],
    skipIf: (data) => !!data.hotelName,
  });

  const askDate = askHotel.nextStep({
    instructions: "Ask for the booking date",
    collect: ["date"],
    skipIf: (data) => !!data.date,
  });

  const askGuests = askDate.nextStep({
    instructions: "Ask for the number of guests",
    collect: ["guests"],
    skipIf: (data) => !!data.guests,
  });

  // No need to specify instructions here - using route-level endStep configuration
  askGuests.nextStep({
    step: END_ROUTE,
  });

  // Route 2: Feedback Collection
  const feedbackRoute = agent.createRoute<FeedbackData>({
    title: "Collect Feedback",
    description: "Collects user feedback after booking",
    conditions: ["User wants to provide feedback"],
    schema: {
      type: "object",
      properties: {
        rating: { type: "number" },
        comments: { type: "string" },
      },
      required: ["rating"],
    },
    // Configure completion message for feedback route
    endStep: {
      instructions:
        "Thank the user warmly for their feedback and let them know their input is valuable",
    },
  });

  const askRating = feedbackRoute.initialStep.nextStep({
    instructions: "Ask for rating from 1 to 5",
    collect: ["rating"],
    skipIf: (data) => !!data.rating,
  });

  const askComments = askRating.nextStep({
    instructions: "Ask for any additional comments (optional)",
    collect: ["comments"],
  });

  // No need to specify instructions here - using route-level endStep configuration
  askComments.nextStep({
    step: END_ROUTE,
  });

  console.log("\n=== Route Transitions Example ===\n");

  // Conversation 1: User provides all booking info at once
  let session: SessionState | undefined;
  let history = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "I want to book the Grand Hotel for 2 guests on December 25th"
    ),
  ];

  console.log("User:", history[0].data.message);

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
      ...createMessageEvent(EventSource.AI_AGENT, "Bot", response1.message),
      id: "2",
    },
  ];

  // Second response - should auto-transition to a feedback route
  history = [
    ...history,
    createMessageEvent(EventSource.CUSTOMER, "Alice", "Yes, please proceed!"),
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
      ...createMessageEvent(EventSource.AI_AGENT, "Bot", response2.message),
      id: "4",
    },
  ];

  // Third response - provide rating
  history = [
    ...history,
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "I'd rate it 5 stars! The process was very smooth."
    ),
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
  let history2 = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Bob",
      "I want to book the Sunset Resort for 4 people on New Year's Eve"
    ),
  ];

  console.log("User:", history2[0].data.message);

  const manualResponse = await agent.respond({
    history: history2,
    session: session2,
  });
  console.log("\nBot:", manualResponse.message);
  console.log("Route complete?", manualResponse.isRouteComplete);

  if (manualResponse.isRouteComplete && manualResponse.session) {
    // Manually trigger transition instead of auto-transition
    console.log("\n[Manually transitioning to feedback route...]");
    session2 = agent.nextStepRoute("Collect Feedback", manualResponse.session);
    console.log(
      "Pending transition set:",
      session2.pendingTransition?.targetRouteId
    );

    history2 = [
      ...history2,
      {
        ...createMessageEvent(
          EventSource.AI_AGENT,
          "Bot",
          manualResponse.message
        ),
        id: "2",
      },
      createMessageEvent(EventSource.CUSTOMER, "Bob", "Great!"),
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

main().catch(console.error);
