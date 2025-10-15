/**
 * Example: Declarative Agent Configuration with Session State
 *
 * This example demonstrates how to configure an entire agent
 * using declarative syntax in the constructor, including:
 * - Terms (glossary)
 * - Guidelines (behavior rules)
 * - Capabilities
 * - Routes with data extraction schemas and custom IDs
 * - Session state management for multi-turn conversations
 */

import {
  Agent,
  defineTool,
  createMessageEvent,
  EventSource,
  GeminiProvider,
  createSession,
  type Term,
  type Guideline,
  type Capability,
  type RouteOptions,
} from "../src/index";

// Context type
interface HealthcareContext {
  patientId: string;
  patientName: string;
}

// Data extraction types
interface AppointmentData {
  appointmentType: "checkup" | "consultation" | "followup";
  preferredDate: string;
  preferredTime: string;
  symptoms?: string;
  urgency: "low" | "medium" | "high";
}

interface LabData {
  testType: string;
  testDate: string;
  resultsNeeded: boolean;
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
  async ({ context, extracted }) => {
    // Tools can now access extracted data
    const labData = extracted as Partial<LabData>;
    if (labData?.testType) {
      return {
        data: {
          report: `${labData.testType} results for ${context.patientName}`,
          status: "All values within normal range",
        },
      };
    }

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

const scheduleAppointment = defineTool<
  HealthcareContext,
  [],
  { confirmation: string }
>(
  "schedule_appointment",
  async ({ context, extracted }) => {
    // Tools can access extracted appointment data
    const appointment = extracted as Partial<AppointmentData>;
    if (!appointment?.preferredDate || !appointment?.preferredTime) {
      return { data: { confirmation: "Please provide appointment details" } };
    }

    return {
      data: {
        confirmation: `Appointment scheduled for ${appointment.preferredDate} at ${appointment.preferredTime}`,
      },
    };
  },
  {
    id: "healthcare_schedule_appointment",
    description: "Schedules patient appointments",
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
    extractionSchema: {
      type: "object",
      properties: {
        appointmentType: {
          type: "string",
          enum: ["checkup", "consultation", "followup"],
          description: "Type of appointment needed",
        },
        preferredDate: {
          type: "string",
          description: "Preferred appointment date",
        },
        preferredTime: {
          type: "string",
          description: "Preferred appointment time",
        },
        symptoms: {
          type: "string",
          description: "Description of symptoms (if applicable)",
        },
        urgency: {
          type: "string",
          enum: ["low", "medium", "high"],
          default: "medium",
        },
      },
      required: ["appointmentType", "preferredDate", "preferredTime"],
    },
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
    extractionSchema: {
      type: "object",
      properties: {
        testType: {
          type: "string",
          description: "Type of lab test",
        },
        testDate: {
          type: "string",
          description: "Date of the lab test",
        },
        resultsNeeded: {
          type: "boolean",
          default: true,
          description: "Whether detailed results are needed",
        },
      },
      required: ["testType"],
    },
    guidelines: [
      {
        condition: "The patient presses for more conclusions about results",
        action:
          "Assertively tell them they should call the office to speak with a doctor",
        tags: ["escalation"],
      },
    ],
  },
  {
    title: "General Healthcare Questions",
    description: "Answer general healthcare questions",
    conditions: ["Patient asks general healthcare questions"],
    // No extractionSchema - stateless Q&A
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

// Example usage with session state
async function main() {
  // Initialize session state
  let session = createSession<AppointmentData | LabData>();

  // Create events with custom timestamps (useful for historical data)
  const history = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "Hi, I need to follow up on my recent visit"
    ),
  ];

  // Turn 1 - Agent responds and extracts intent
  const response = await agent.respond({ history, session });
  console.log("Agent:", response.message);
  console.log("Route chosen:", response.session?.currentRoute?.title);
  console.log("Extracted data:", response.session?.extracted);

  // Session state is updated with progress
  session = response.session!;

  // Turn 2 - Continue conversation with session state
  if (response.session?.currentRoute?.title === "Schedule Appointment") {
    const history2 = [
      ...history,
      createMessageEvent(EventSource.AI_AGENT, "Bot", response.message),
      createMessageEvent(
        EventSource.CUSTOMER,
        "Alice",
        "I need a checkup next week"
      ),
    ];

    const response2 = await agent.respond({ history: history2, session });
    console.log("Agent:", response2.message);
    console.log("Updated extracted:", response2.session?.extracted);

    // Session tracks the appointment booking progress
    console.log("Current state:", response2.session?.currentState?.id);
  }

  // Note: Custom IDs ensure consistency across server restarts
  // Session state enables:
  // - Tracking conversation progress across turns
  // - Extracting structured data throughout conversation
  // - Always-on routing that respects user intent changes
  // - State recovery for resuming conversations
}

// Uncomment to run:
// main().catch(console.error);

export { agent };
