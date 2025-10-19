/**
 * Example: Declarative Agent Configuration with Sequential Steps
 *
 * This example demonstrates how to configure an entire agent
 * using declarative syntax in the constructor, including:
 * - Terms (domain glossary)
 * - Guidelines (behavior rules)
 * - Tools (capabilities)
 * - Routes with data extraction schemas and sequential steps
 * - Session management for multi-turn conversations
 */

import {
  Agent,
  GeminiProvider,
  createSession,
  type Term,
  type Guideline,
  type Tool,
  type RouteOptions,
  History,
} from "../../src/index";

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

// Define tools using the new Tool interface
const getInsuranceProviders: Tool<HealthcareContext, [], string[]> = {
  id: "healthcare_insurance_providers",
  description: "Retrieves list of accepted insurance providers",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: () => {
    return {
      data: ["MegaCare Insurance", "HealthFirst", "WellnessPlus"],
    };
  },
};

const getAvailableSlots: Tool<
  HealthcareContext,
  [],
  { date: string; time: string }[]
> = {
  id: "healthcare_available_slots",
  description: "Gets available appointment slots",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: () => {
    return {
      data: [
        { date: "2025-10-20", time: "10:00 AM" },
        { date: "2025-10-20", time: "2:00 PM" },
        { date: "2025-10-21", time: "1:00 PM" },
      ],
    };
  },
};

const getLabResults: Tool<
  HealthcareContext,
  [],
  { report: string; status: string }
> = {
  id: "healthcare_lab_results",
  description: "Retrieves patient lab results",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: ({
    context,
    data,
  }: {
    context: HealthcareContext;
    data?: Partial<LabData>;
  }) => {
    // Tools can access collected data and context
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
};

const scheduleAppointment: Tool<
  HealthcareContext,
  [],
  { confirmation: string }
> = {
  id: "healthcare_schedule_appointment",
  description: "Schedules patient appointments",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: ({
    data,
  }: {
    context: HealthcareContext;
    data?: Partial<AppointmentData>;
  }) => {
    // Tools access collected appointment data
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
};

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
    tags: ["insurance", "billing"],
  },
  {
    condition: "The patient asks to talk to a human agent",
    action: ({ context }: { context?: HealthcareContext }) =>
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

const routes: RouteOptions<HealthcareContext>[] = [
  {
    id: "route_schedule_appointment",
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
        condition: "The patient says their visit is urgent",
        action: "Tell them to call the office immediately",
        tags: ["urgent"],
        enabled: true,
      },
    ],
    // Sequential steps for a linear booking flow
    steps: [
      {
        id: "ask_appointment_type",
        description: "Ask for appointment type",
        prompt:
          "What type of appointment do you need? (checkup, consultation, or followup)",
        collect: ["appointmentType"],
      },
      {
        id: "ask_date_time",
        description: "Ask for preferred date and time",
        prompt: "When would you like to come in?",
        collect: ["preferredDate", "preferredTime"],
        requires: ["appointmentType"], // Must have appointment type first
      },
      {
        id: "ask_symptoms",
        description: "Ask about symptoms",
        prompt: "Are you experiencing any symptoms?",
        collect: ["symptoms"],
        skipIf: (data: Partial<AppointmentData>) =>
          data.appointmentType === "checkup", // Skip for checkups
      },
      {
        id: "schedule_appointment",
        description: "Schedule the appointment",
        prompt: "I'll schedule your appointment now.",
        tools: [scheduleAppointment], // Use the scheduling tool
        requires: ["preferredDate", "preferredTime"],
        prepare: getInsuranceProviders, // Use existing tool to prepare insurance info
        finalize: {
          // Inline tool to handle appointment finalization
          id: "finalize_appointment",
          description: "Complete the appointment booking process",
          parameters: { type: "object", properties: {} },
          handler: ({ context, data }) => {
            console.log(`✅ Appointment finalized for ${context.patientName}`);
            console.log(`📅 Details: ${JSON.stringify(data, null, 2)}`);

            // Could send confirmation email, update calendar, etc.
            return {
              data: `Appointment confirmed for ${context.patientName}`,
            };
          },
        },
      },
    ],
    tools: [getAvailableSlots], // Route-level tools available to all steps
  },
  {
    id: "route_check_lab_results",
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
        condition: "The patient presses for more conclusions about results",
        action:
          "Assertively tell them they should call the office to speak with a doctor",
        tags: ["escalation"],
      },
    ],
    tools: [getLabResults], // Route-level tools
  },
  {
    title: "General Healthcare Questions",
    description: "Answer general healthcare questions",
    conditions: ["Patient asks general healthcare questions"],
    // No schema - conversational Q&A
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
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY || "demo-key",
    model: "models/gemini-2.5-flash",
  }),
  // Declarative initialization
  terms,
  guidelines,
  tools: [getInsuranceProviders], // Agent-level tools
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

// Example usage with session management

async function main() {
  // Initialize session
  let session = createSession<AppointmentData | LabData>();

  // Create conversation history
  const history: History = [
    {
      role: "user",
      content: "Hi, I need to follow up on my recent visit",
      name: "Alice",
    },
  ];

  // Turn 1 - Agent responds and routes to appropriate flow
  console.log("🔄 Turn 1: Initial inquiry");
  const response1 = await agent.respond({ history, session });
  console.log("🤖 Agent:", response1.message);
  console.log("🛤️  Route chosen:", response1.session?.currentRoute?.title);

  // Session is updated with progress
  session = response1.session!;

  // Turn 2 - User provides more details
  console.log("\n🔄 Turn 2: Providing appointment details");
  const history2: History = [
    ...history,
    {
      role: "assistant",
      content: response1.message,
    },
    {
      role: "user",
      content: "I need a checkup next Tuesday at 2 PM",
      name: "Alice",
    },
  ];

  const response2 = await agent.respond({ history: history2, session });
  console.log("🤖 Agent:", response2.message);
  console.log("📊 Collected data:", response2.session?.data);
  console.log("📍 Current step:", response2.session?.currentStep?.id);

  session = response2.session!;

  // Turn 3 - Continue the conversation flow
  console.log("\n🔄 Turn 3: Continuing appointment booking");
  const history3: History = [
    ...history2,
    {
      role: "assistant",
      content: response2.message,
    },
    {
      role: "user",
      content: "I'm feeling a bit anxious about the visit",
      name: "Alice",
    },
  ];

  const response3 = await agent.respond({ history: history3, session });
  console.log("🤖 Agent:", response3.message);
  console.log("📊 Updated data:", response3.session?.data);
  console.log("📍 Current step:", response3.session?.currentStep?.id);

  // Check for route completion
  if (response3.isRouteComplete && response3.session) {
    console.log("\n✅ Appointment scheduling complete!");
    await sendAppointmentConfirmation(
      agent.getData<AppointmentData>(response3.session.id) as AppointmentData
    );
  }

  console.log("\n📋 Session Summary:");
  console.log(
    "- Agent-level tools:",
    agent.getTools().map((t) => t.id)
  );
  console.log(
    "- Available routes:",
    agent.getRoutes().map((r) => r.title)
  );
  console.log("- Agent guidelines:", agent.getGuidelines().length);
  console.log("- Agent terms:", agent.getTerms().length);
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
    `   - Confirmation sent for ${data.preferredDate} at ${data.preferredTime}`
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log("✨ Confirmation delivered!");
}

export { agent };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
