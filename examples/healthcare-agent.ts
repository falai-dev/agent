/**
 * Healthcare agent example demonstrating route-based
 * Updated for v2 architecture with session state management and schema-first data extraction
 */

import {
  Agent,
  defineTool,
  AnthropicProvider,
  END_ROUTE,
  EventSource,
  createMessageEvent,
  createSession,
} from "../src/index";

// Context type
interface HealthcareContext {
  patientId: string;
  patientName: string;
}

// Data extraction types for healthcare scenarios
interface AppointmentData {
  appointmentReason?: string;
  urgency?: "low" | "medium" | "high";
  preferredTime?: string;
  preferredDate?: string;
  appointmentType?: "checkup" | "consultation" | "followup";
}

interface LabResultsData {
  testType?: string;
  testDate?: string;
  resultsNeeded?: boolean;
}

// Tools
const getInsuranceProviders = defineTool<HealthcareContext, [], string[]>(
  "get_insurance_providers",
  async () => {
    return { data: ["Mega Insurance", "Acme Insurance"] };
  },
  { description: "Get list of accepted insurance providers" }
);

const getUpcomingSlots = defineTool<HealthcareContext, [], string[]>(
  "get_upcoming_slots",
  async () => {
    return { data: ["Monday 10 AM", "Tuesday 2 PM", "Wednesday 1 PM"] };
  },
  { description: "Get upcoming appointment slots" }
);

const getLaterSlots = defineTool<HealthcareContext, [], string[]>(
  "get_later_slots",
  async () => {
    return { data: ["November 3, 11:30 AM", "November 12, 3 PM"] };
  },
  { description: "Get later appointment slots" }
);

const scheduleAppointment = defineTool<
  HealthcareContext,
  [datetime: string],
  string
>("schedule_appointment", async ({ context, extracted }, datetime) => {
  const appointment = extracted as Partial<AppointmentData>;
  if (!appointment?.preferredDate || !appointment?.preferredTime) {
    return {
      data: "Please specify preferred date and time for the appointment",
    };
  }
  return {
    data: `Appointment scheduled for ${appointment.preferredDate} at ${
      appointment.preferredTime
    } for ${appointment.appointmentReason || "consultation"}`,
  };
});

const getLabResults = defineTool<HealthcareContext, [], object>(
  "get_lab_results",
  async ({ context, extracted }) => {
    const labData = extracted as Partial<LabResultsData>;
    return {
      data: {
        report: `Lab results for ${labData?.testType || "general"} tests`,
        prognosis: "All tests are within the valid range",
        patientName: context.patientName,
      },
    };
  }
);

async function createHealthcareAgent() {
  const provider = new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY || "test-key",
    model: "claude-sonnet-4-5",
  });

  const agent = new Agent<HealthcareContext>({
    name: "Healthcare Agent",
    description: "Is empathetic and calming to the patient.",
    ai: provider,
    context: {
      patientId: "patient-123",
      patientName: "Test Patient",
    },
  });

  // Add domain glossary
  agent.createTerm({
    name: "Office Phone Number",
    description: "The phone number of our office, at +1-234-567-8900",
  });

  agent.createTerm({
    name: "Office Hours",
    description: "Office hours are Monday to Friday, 9 AM to 5 PM",
  });

  agent.createTerm({
    name: "Charles Xavier",
    synonyms: ["Professor X"],
    description:
      "The doctor who specializes in neurology and is available on Mondays and Tuesdays.",
  });

  // Create scheduling route with data extraction schema
  const schedulingRoute = agent.createRoute<AppointmentData>({
    title: "Schedule an Appointment",
    description: "Helps the patient find a time for their appointment.",
    conditions: ["The patient wants to schedule an appointment"],
    extractionSchema: {
      type: "object",
      properties: {
        appointmentReason: {
          type: "string",
          description: "Reason for the appointment",
        },
        urgency: {
          type: "string",
          enum: ["low", "medium", "high"],
          default: "medium",
        },
        preferredTime: {
          type: "string",
          description: "Preferred time slot",
        },
        preferredDate: {
          type: "string",
          description: "Preferred date",
        },
        appointmentType: {
          type: "string",
          enum: ["checkup", "consultation", "followup"],
          default: "consultation",
        },
      },
      required: ["appointmentReason"],
    },
  });

  // State 1: Gather appointment reason
  const gatherReason = schedulingRoute.initialState.transitionTo({
    chatState: "Ask what the patient needs an appointment for",
    gather: ["appointmentReason"],
    skipIf: (extracted) => !!extracted.appointmentReason,
    condition: "Patient hasn't specified reason for appointment yet",
  });

  // State 2: Check urgency and show available slots
  const checkUrgency = gatherReason.transitionTo({
    chatState: "Check if this is urgent and show available slots",
    gather: ["urgency"],
    skipIf: (extracted) => !!extracted.urgency,
    requiredData: ["appointmentReason"],
    condition: "Reason provided, now assess urgency level",
  });

  const showSlots = checkUrgency.transitionTo({
    toolState: getUpcomingSlots,
  });

  // State 3: Present available times
  const presentTimes = showSlots.transitionTo({
    chatState: "List available times and ask which one works for them",
  });

  // State 4: Gather preferred time and date
  const gatherPreferences = presentTimes.transitionTo({
    chatState: "Collect preferred time and date",
    gather: ["preferredTime", "preferredDate"],
    skipIf: (extracted) =>
      !!extracted.preferredTime && !!extracted.preferredDate,
  });

  // State 5: Confirm details and schedule
  const confirmDetails = gatherPreferences.transitionTo({
    chatState: "Confirm the details with the patient before scheduling",
    gather: ["appointmentType"],
    skipIf: (extracted) => !!extracted.appointmentType,
    requiredData: ["appointmentReason", "preferredTime", "preferredDate"],
  });

  const schedule = confirmDetails.transitionTo({
    toolState: scheduleAppointment,
    requiredData: ["appointmentReason", "preferredTime", "preferredDate"],
    condition: "All details confirmed, book the appointment",
  });

  const confirmation = schedule.transitionTo({
    chatState: "Confirm the appointment has been scheduled",
  });

  confirmation.transitionTo({
    state: END_ROUTE,
    condition: "Appointment booked successfully",
  });

  // Alternative path: no times work - show later slots
  const laterSlots = presentTimes.transitionTo({
    toolState: getLaterSlots,
  });

  laterSlots.transitionTo({
    chatState: "List later times and ask if any of them works",
  });

  // If no times work at all, end route
  laterSlots
    .transitionTo({
      chatState:
        "Ask the patient to call the office to schedule an appointment",
    })
    .transitionTo({ state: END_ROUTE });

  schedulingRoute.createGuideline({
    condition: "The patient says their visit is urgent",
    action: "Tell them to call the office immediately",
  });

  // Create lab results route with data extraction schema
  const labResultsRoute = agent.createRoute<LabResultsData>({
    title: "Lab Results",
    description: "Retrieves the patient's lab results and explains them.",
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
  });

  // State 1: Gather test information
  const gatherTestInfo = labResultsRoute.initialState.transitionTo({
    chatState: "Ask what type of test results they want to see",
    gather: ["testType"],
    skipIf: (extracted) => !!extracted.testType,
  });

  // State 2: Optional: gather test date
  const gatherTestDate = gatherTestInfo.transitionTo({
    chatState: "Ask for the test date if they remember it",
    gather: ["testDate"],
    skipIf: (extracted) => !!extracted.testDate,
    requiredData: ["testType"],
  });

  // State 3: Get lab results
  const getResults = gatherTestDate.transitionTo({
    toolState: getLabResults,
    requiredData: ["testType"],
  });

  // State 4: Present results based on status
  const presentResults = getResults.transitionTo({
    chatState: "Present the lab results and explain what they mean",
  });

  presentResults.transitionTo({ state: END_ROUTE });

  labResultsRoute.createGuideline({
    condition:
      "The patient presses you for more conclusions about the lab results",
    action:
      "Assertively tell them that you cannot help and they should call the office",
  });

  // Global guidelines
  agent.createGuideline({
    condition: "The patient asks about insurance",
    action:
      "List the insurance providers we accept, and tell them to call the office for more details",
    tools: [getInsuranceProviders],
  });

  agent.createGuideline({
    condition: "The patient asks to talk to a human agent",
    action: "Ask them to call the office, providing the phone number",
  });

  agent.createGuideline({
    condition:
      "The patient inquires about something that has nothing to do with our healthcare",
    action:
      "Kindly tell them you cannot assist with off-topic inquiries - do not engage with their request.",
  });

  return agent;
}

// Example usage with session state management
async function main() {
  const agent = await createHealthcareAgent();

  // Initialize session state for multi-turn conversation
  let session = createSession<AppointmentData | LabResultsData>();

  const history = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Patient",
      "Hi, I need to follow up on my visit"
    ),
  ];

  console.log("Agent:", agent.name);
  console.log("Description:", agent.description);
  console.log("\nRoutes:", agent.getRoutes().length);
  console.log("Terms:", agent.getTerms().length);
  console.log("Guidelines:", agent.getGuidelines().length);

  // Print routes
  const routes = agent.getRoutes();
  for (const route of routes) {
    console.log("\n" + route.describe());
  }

  // Example conversation with session state
  console.log("\n=== EXAMPLE CONVERSATION ===");

  // Turn 1: Patient wants to follow up
  const response1 = await agent.respond({ history, session });
  console.log("Patient: Hi, I need to follow up on my visit");
  console.log("Agent:", response1.message);
  console.log("Route:", response1.session?.currentRoute?.title);
  console.log("Extracted:", response1.session?.extracted);

  // Update session with progress
  session = response1.session!;

  // Turn 2: Patient specifies they want to schedule an appointment
  if (response1.session?.currentRoute?.title === "Schedule an Appointment") {
    const history2 = [
      ...history,
      createMessageEvent(EventSource.AI_AGENT, "Agent", response1.message),
      createMessageEvent(
        EventSource.CUSTOMER,
        "Patient",
        "I need to schedule a checkup for next week"
      ),
    ];

    const response2 = await agent.respond({ history: history2, session });
    console.log("\nPatient: I need to schedule a checkup for next week");
    console.log("Agent:", response2.message);
    console.log("Updated extracted:", response2.session?.extracted);
    console.log("Current state:", response2.session?.currentState?.id);

    // Update session again
    session = response2.session!;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { createHealthcareAgent };
