/**
 * Example: Declarative Agent Configuration
 *
 * This example demonstrates how to configure an entire agent
 * using declarative syntax in the constructor, including:
 * - Terms (glossary)
 * - Guidelines (behavior rules)
 * - Capabilities
 * - Routes with nested guidelines
 * - Observations with route references
 */

import {
  Agent,
  GeminiProvider,
  defineTool,
  createMessageEvent,
  EventSource,
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

// Define tools
const getInsuranceProviders = defineTool<HealthcareContext, [], string[]>(
  "get_insurance_providers",
  async () => {
    return { data: ["MegaCare Insurance", "HealthFirst", "WellnessPlus"] };
  },
  { description: "Retrieves list of accepted insurance providers" }
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
  { description: "Gets available appointment slots" }
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
  { description: "Retrieves patient lab results" }
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
  const history = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "Hi, I need to follow up on my recent visit"
    ),
  ];

  const response = await agent.respond({ history });
  console.log("Agent:", response.message);

  // The agent will use the observation to disambiguate
  // and ask which type of follow-up the patient needs
}

// Uncomment to run:
// main().catch(console.error);

export { agent };
