/**
 * Example: Declarative Agent Configuration
 *
 * This example demonstrates how to configure an entire agent
 * using declarative syntax in the constructor, including:
 * - Terms (glossary)
 * - Guidelines (behavior rules)
 * - Capabilities
 * - Routes with nested guidelines and custom IDs
 * - Observations with route references and custom IDs
 * - Custom timestamps for events
 */

import {
  Agent,
  defineTool,
  createMessageEvent,
  EventSource,
  GeminiProvider,
  type Term,
  type Guideline,
  type Capability,
  type RouteOptions,
  type ObservationOptions,
} from "../src/index";

// Context type
interface HealthcareContext {
  patientId: string;
  patientName: string;
}

// Define tools with custom IDs (optional - IDs are deterministic by default)
const getInsuranceProviders = defineTool<HealthcareContext, [], string[]>(
  "get_insurance_providers",
  async () => {
    return { data: ["MegaCare Insurance", "HealthFirst", "WellnessPlus"] };
  },
  {
    id: "healthcare_insurance_providers", // Custom ID for persistence
    description: "Retrieves list of accepted insurance providers",
  }
);

const getAvailableSlots = defineTool<
  HealthcareContext,
  [],
  { date: string; time: string }[]
>(
  "get_available_slots",
  async () => {
    return {
      data: [
        { date: "2025-10-20", time: "10:00 AM" },
        { date: "2025-10-20", time: "2:00 PM" },
        { date: "2025-10-21", time: "1:00 PM" },
      ],
    };
  },
  {
    id: "healthcare_available_slots", // Custom ID
    description: "Gets available appointment slots",
  }
);

const getLabResults = defineTool<
  HealthcareContext,
  [],
  { report: string; status: string }
>(
  "get_lab_results",
  async ({ context }) => {
    return {
      data: {
        report: `Lab results for ${context.patientName}`,
        status: "All values within normal range",
      },
    };
  },
  {
    id: "healthcare_lab_results", // Custom ID
    description: "Retrieves patient lab results",
  }
);

// Declarative configuration
const terms: Term[] = [
  {
    name: "Office Phone Number",
    description: "The phone number of our office, at +1-234-567-8900",
  },
  {
    name: "Office Hours",
    description: "Office hours are Monday to Friday, 9 AM to 5 PM",
  },
  {
    name: "Dr. Charles Xavier",
    description: "Neurologist specializing in brain disorders",
    synonyms: ["Professor X", "Dr. Xavier"],
  },
];

const guidelines: Guideline[] = [
  {
    condition: "The patient asks about insurance",
    action:
      "List the insurance providers we accept and tell them to call the office for more details",
    tools: [getInsuranceProviders],
    tags: ["insurance", "billing"],
  },
  {
    condition: "The patient asks to talk to a human agent",
    action: "Provide the office phone number and office hours",
    tags: ["escalation"],
  },
  {
    condition: "The patient inquires about something unrelated to healthcare",
    action:
      "Kindly tell them you cannot assist with off-topic inquiries - do not engage",
    tags: ["off-topic"],
  },
];

const capabilities: Capability[] = [
  {
    title: "Appointment Scheduling",
    description: "Schedule, reschedule, or cancel patient appointments",
    tools: [getAvailableSlots],
  },
  {
    title: "Lab Results Access",
    description: "Retrieve and explain patient lab results",
    tools: [getLabResults],
  },
];

const routes: RouteOptions[] = [
  {
    id: "route_schedule_appointment", // Custom ID ensures consistency across restarts
    title: "Schedule Appointment",
    description: "Helps the patient schedule an appointment",
    conditions: ["The patient wants to schedule an appointment"],
    guidelines: [
      {
        condition: "The patient says their visit is urgent",
        action: "Tell them to call the office immediately",
        tags: ["urgent"],
        enabled: true,
      },
    ],
  },
  {
    id: "route_check_lab_results", // Custom ID
    title: "Check Lab Results",
    description: "Retrieves and explains patient lab results",
    conditions: ["The patient wants to see their lab results"],
    guidelines: [
      {
        condition: "The patient presses for more conclusions about results",
        action:
          "Assertively tell them they should call the office to speak with a doctor",
        tags: ["escalation"],
      },
    ],
  },
];

const observations: ObservationOptions[] = [
  {
    id: "obs_visit_followup", // Custom ID for tracking
    description:
      "The patient asks to follow up on their visit, but it's not clear in which way",
    routeRefs: ["Schedule Appointment", "Check Lab Results"], // Reference by title
  },
];

// Create the fully configured agent
const agent = new Agent<HealthcareContext>({
  name: "HealthBot",
  description: "A compassionate healthcare assistant",
  goal: "Provide helpful information and assist with appointments",
  context: {
    patientId: "p_12345",
    patientName: "Alice Johnson",
  },
  ai: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY || "demo-key",
    model: "models/gemini-2.5-flash",
  }),
  // Declarative initialization
  terms,
  guidelines,
  capabilities,
  routes,
  observations,
});

// You can still add more dynamically after construction
agent
  .createGuideline({
    condition: "The patient seems confused or distressed",
    action: "Speak slowly, clearly, and offer to connect them with a human",
    tags: ["empathy", "support"],
  })
  .createTerm({
    name: "Telemedicine",
    description: "Remote medical consultation via video call",
    synonyms: ["virtual visit", "video appointment"],
  });

// Example usage
async function main() {
  // Create events with custom timestamps (useful for historical data)
  const history = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "Hi, I need to follow up on my recent visit",
      "2025-10-13T14:30:00Z" // Optional custom timestamp
    ),
  ];

  const response = await agent.respond({ history });
  console.log("Agent:", response.message);
  console.log("Route chosen:", response.route?.title);
  console.log("Route ID:", response.route?.id); // Custom ID is preserved

  // The agent will use the observation to disambiguate
  // and ask which type of follow-up the patient needs

  // Note: Custom IDs ensure consistency across server restarts
  // This is crucial for:
  // - Storing conversation state in databases
  // - Tracking metrics and analytics
  // - Referencing routes in external systems
}

// Uncomment to run:
// main().catch(console.error);

export { agent };
