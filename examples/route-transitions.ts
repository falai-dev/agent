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
  END_STATE,
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
    ai: new GeminiProvider({
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
    extractionSchema: {
      type: "object",
      properties: {
        hotelName: { type: "string" },
        date: { type: "string" },
        guests: { type: "number" },
      },
      required: ["hotelName", "date", "guests"],
    },
    // Configure completion message at route level
    endState: {
      chatState: "Confirm the booking with a summary of the hotel, date, and number of guests. Be enthusiastic!",
    },
    // Option 1: Simple string
    onComplete: "Collect Feedback",
    // Option 2: Object with condition
    // onComplete: {
    //   transitionTo: "Collect Feedback",
    //   condition: "if booking was successful"
    // },
    // Option 3: Function with logic
    // onComplete: (session) => {
    //   if (session.extracted?.guests && session.extracted.guests > 5) {
    //     return "VIP Feedback"; // Different feedback for large groups
    //   }
    //   return "Collect Feedback";
    // },
  });

  const askHotel = bookingRoute.initialState.transitionTo({
    chatState: "Ask which hotel they want to book",
    gather: ["hotelName"],
    skipIf: (extracted) => !!extracted.hotelName,
  });

  const askDate = askHotel.transitionTo({
    chatState: "Ask for the booking date",
    gather: ["date"],
    skipIf: (extracted) => !!extracted.date,
  });

  const askGuests = askDate.transitionTo({
    chatState: "Ask for the number of guests",
    gather: ["guests"],
    skipIf: (extracted) => !!extracted.guests,
  });

  // No need to specify chatState here - using route-level endState configuration
  askGuests.transitionTo({
    state: END_STATE,
  });

  // Route 2: Feedback Collection
  const feedbackRoute = agent.createRoute<FeedbackData>({
    title: "Collect Feedback",
    description: "Collects user feedback after booking",
    conditions: ["User wants to provide feedback"],
    extractionSchema: {
      type: "object",
      properties: {
        rating: { type: "number" },
        comments: { type: "string" },
      },
      required: ["rating"],
    },
    // Configure completion message for feedback route
    endState: {
      chatState: "Thank the user warmly for their feedback and let them know their input is valuable",
    },
  });

  const askRating = feedbackRoute.initialState.transitionTo({
    chatState: "Ask for rating from 1 to 5",
    gather: ["rating"],
    skipIf: (extracted) => !!extracted.rating,
  });

  const askComments = askRating.transitionTo({
    chatState: "Ask for any additional comments (optional)",
    gather: ["comments"],
  });

  // No need to specify chatState here - using route-level endState configuration
  askComments.transitionTo({
    state: END_STATE,
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
  console.log("Extracted booking data:", response1.session?.extracted);

  session = response1.session;
  history = [
    ...history,
    { ...createMessageEvent(EventSource.AI_AGENT, "Bot", response1.message), id: "2" },
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
    { ...createMessageEvent(EventSource.AI_AGENT, "Bot", response2.message), id: "4" },
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
  console.log("Extracted feedback data:", response3.session?.extracted);
  console.log("Route complete?", response3.isRouteComplete);

  console.log("\n=== Manual Transition Example ===\n");

  // Demonstrate manual transition using agent.transitionToRoute()
  let session2: SessionState | undefined;
  let history2 = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Bob",
      "I want to book the Sunset Resort for 4 people on New Year's Eve"
    ),
  ];

  console.log("User:", history2[0].data.message);

  const manualResponse = await agent.respond({ history: history2, session: session2 });
  console.log("\nBot:", manualResponse.message);
  console.log("Route complete?", manualResponse.isRouteComplete);

  if (manualResponse.isRouteComplete && manualResponse.session) {
    // Manually trigger transition instead of auto-transition
    console.log("\n[Manually transitioning to feedback route...]");
    session2 = agent.transitionToRoute("Collect Feedback", manualResponse.session);
    console.log(
      "Pending transition set:",
      session2.pendingTransition?.targetRouteId
    );

    history2 = [
      ...history2,
      { ...createMessageEvent(EventSource.AI_AGENT, "Bot", manualResponse.message), id: "2" },
      createMessageEvent(EventSource.CUSTOMER, "Bob", "Great!"),
    ];

    const feedbackResponse = await agent.respond({ history: history2, session: session2 });
    console.log("\nBot:", feedbackResponse.message);
    console.log("Current route:", feedbackResponse.session?.currentRoute?.title);
  }

  console.log("\n=== Done ===\n");
}

main().catch(console.error);
