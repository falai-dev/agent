/**
 * Example: Declarative Agent Configuration with Session Step
 *
 * This example demonstrates how to configure an entire agent
 * using declarative syntax in the constructor, including:
 * - Terms (glossary)
 * - Guidelines (behavior rules)
 * - Capabilities
 * - Routes with data extraction schemas and custom IDs
 * - Session step management for multi-turn conversations
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
const getInsuranceProviders = defineTool<HealthcareContext, [], string[]>({
  name: "get_insurance_providers",
  handler: () => {
    return { data: ["MegaCare Insurance", "HealthFirst", "WellnessPlus"] };
  },
  id: "healthcare_insurance_providers", // Custom ID for persistence
  description: "Retrieves list of accepted insurance providers",
});

const getAvailableSlots = defineTool<
  HealthcareContext,
  [],
  { date: string; time: string }[]
>({
  name: "get_available_slots",
  handler: () => {
    return {
      data: [
        { date: "2025-10-20", time: "10:00 AM" },
        { date: "2025-10-20", time: "2:00 PM" },
        { date: "2025-10-21", time: "1:00 PM" },
      ],
    };
  },
  id: "healthcare_available_slots", // Custom ID
  description: "Gets available appointment slots",
});

const getLabResults = defineTool<
  HealthcareContext,
  [],
  { report: string; status: string }
>({
  name: "get_lab_results",
  handler: ({ context, data }) => {
    // Tools can now access collected data
    const labData = data as Partial<LabData>;
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
  id: "healthcare_lab_results", // Custom ID
  description: "Retrieves patient lab results",
});

const scheduleAppointment = defineTool<HealthcareContext>({
  name: "schedule_appointment",
  handler: ({ context: _context, data }) => {
    // Tools can access data appointment data
    const appointment = data as Partial<AppointmentData>;
    if (!appointment?.preferredDate || !appointment?.preferredTime) {
      return { data: { confirmation: "Please provide appointment details" } };
    }

    return {
      data: {
        confirmation: `Appointment scheduled for ${appointment.preferredDate} at ${appointment.preferredTime}`,
      },
    };
  },
  id: "healthcare_schedule_appointment",
  description: "Schedules patient appointments",
});

// Declarative configuration
const terms: Term<HealthcareContext>[] = [
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
    description: ({ context }) =>
      `Neurologist specializing in brain disorders for patient ${context?.patientName}`,
    synonyms: ["Professor X", "Dr. Xavier"],
  },
];

const guidelines: Guideline<HealthcareContext>[] = [
  {
    condition: "The patient asks about insurance",
    action:
      "List the insurance providers we accept and tell them to call the office for more details",
    tools: [getInsuranceProviders],
    tags: ["insurance", "billing"],
  },
  {
    condition: "The patient asks to talk to a human agent",
    action: ({ context }) =>
      `Of course. You can reach our office at +1-234-567-8900 during office hours (Monday to Friday, 9 AM to 5 PM). I've noted that you'd like to speak with someone, and I can have a representative call you back if you'd like, ${context?.patientName}.`,
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

const routes: RouteOptions<HealthcareContext>[] = [
  {
    id: "route_schedule_appointment", // Custom ID ensures consistency across restarts
    title: "Schedule Appointment",
    description: "Helps the patient schedule an appointment",
    conditions: ["The patient wants to schedule an appointment"],
    schema: {
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
        when: "The patient says their visit is urgent",
        action: "Tell them to call the office immediately",
        tags: ["urgent"],
        enabled: true,
      },
    ],
    // NEW: Use sequential steps for a linear booking flow
    steps: [
      {
        id: "ask_appointment_type",
        prompt:
          "What type of appointment do you need? (checkup, consultation, or followup)",
        collect: ["appointmentType"],
      },
      {
        id: "ask_date_time",
        prompt: "When would you like to come in?",
        collect: ["preferredDate", "preferredTime"],
        requires: ["appointmentType"],
      },
      {
        id: "ask_symptoms",
        prompt: "Are you experiencing any symptoms?",
        collect: ["symptoms"],
      },
      {
        id: "confirm_appointment",
        tool: scheduleAppointment,
        requires: ["preferredDate", "preferredTime"],
      },
      {
        id: "final_confirmation",
        prompt:
          "Your appointment is confirmed. You will receive a notification shortly.",
      },
    ],
  },
  {
    id: "route_check_lab_results", // Custom ID
    title: "Check Lab Results",
    description: "Retrieves and explains patient lab results",
    conditions: ["The patient wants to see their lab results"],
    schema: {
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
        when: "The patient presses for more conclusions about results",
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
    // No schema - stepless Q&A
  },
] as RouteOptions[];

// Create the fully configured agent
const agent = new Agent<HealthcareContext>({
  name: "HealthBot",
  description: "A compassionate healthcare assistant",
  goal: "Provide helpful information and assist with appointments",
  context: {
    patientId: "p_12345",
    patientName: "Alice Johnson",
  },
  provider: new GeminiProvider({
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

// Example usage with session step

async function main() {
  // Initialize session step
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
  console.log("Collected data:", response.session?.data);

  // Session step is updated with progress
  session = response.session!;

  // Turn 2 - Continue conversation with session step
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
    console.log("Updated data:", response2.session?.data);

    // Session tracks the appointment booking progress
    console.log("Current step:", response2.session?.currentStep?.id);

    // Check for route completion
    if (response2.isRouteComplete && response2.session) {
      console.log("\n✅ Appointment scheduling complete!");
      await sendAppointmentConfirmation(
        agent.getData(response2.session.id) as AppointmentData
      );
    }
  }

  // Note: Custom IDs ensure consistency across server restarts
  // Session step enables:
  // - Tracking conversation progress across turns
  // - Extracting structured data throughout conversation
  // - Always-on routing that respects user intent changes
  // - Step recovery for resuming conversations
}

/**
 * Mock function to send an appointment confirmation.
 * @param data - The appointment data.
 */
async function sendAppointmentConfirmation(data: AppointmentData) {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 Sending Appointment Confirmation...");
  console.log("=".repeat(60));
  console.log("Appointment Details:", JSON.stringify(data, null, 2));
  console.log(
    `   - Sending confirmation to patient for ${data.preferredDate} at ${data.preferredTime}.`
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("✨ Confirmation sent!");
}

// Uncomment to run:
// main().catch(console.error);

export { agent };

main().catch(console.error);
