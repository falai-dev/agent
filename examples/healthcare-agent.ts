/**
 * Healthcare agent example demonstrating observations and disambiguation
 */

import {
  Agent,
  defineTool,
  GeminiProvider,
  END_ROUTE,
  EventSource,
  createMessageEvent,
} from "../src/index";

// Context type
interface HealthcareContext {
  patientId: string;
  patientName: string;
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
>("schedule_appointment", async (_, datetime) => {
  return { data: `Appointment scheduled for ${datetime}` };
});

const getLabResults = defineTool<HealthcareContext, [], object>(
  "get_lab_results",
  async ({ context }) => {
    return {
      data: {
        report: "All tests are within the valid range",
        prognosis: "Patient is healthy as a horse!",
      },
    };
  }
);

async function createHealthcareAgent() {
  const provider = new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY || "test-key",
    model: "models/gemini-2.5-flash",
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

  // Create scheduling route
  const schedulingRoute = agent.createRoute({
    title: "Schedule an Appointment",
    description: "Helps the patient find a time for their appointment.",
    conditions: ["The patient wants to schedule an appointment"],
  });

  const t0 = schedulingRoute.initialState.transitionTo({
    chatState: "Determine the reason for the visit",
  });

  const t1 = t0.target.transitionTo({
    toolState: getUpcomingSlots,
  });

  const t2 = t1.target.transitionTo({
    chatState: "List available times and ask which ones works for them",
  });

  const t3 = t2.target.transitionTo(
    {
      chatState: "Confirm the details with the patient before scheduling",
    },
    "The patient picks a time"
  );

  const t4 = t3.target.transitionTo(
    {
      toolState: scheduleAppointment,
    },
    "The patient confirms the details"
  );

  const t5 = t4.target.transitionTo({
    chatState: "Confirm the appointment has been scheduled",
  });

  t5.target.transitionTo({ state: END_ROUTE });

  // Alternative path: no times work
  const t6 = t2.target.transitionTo(
    {
      toolState: getLaterSlots,
    },
    "None of those times work for the patient"
  );

  const t7 = t6.target.transitionTo({
    chatState: "List later times and ask if any of them works",
  });

  t7.target.transitionTo(
    {
      state: t3.target,
    },
    "The patient picks a time"
  );

  const t8 = t7.target.transitionTo(
    {
      chatState:
        "Ask the patient to call the office to schedule an appointment",
    },
    "None of those times work for the patient either"
  );

  t8.target.transitionTo({ state: END_ROUTE });

  schedulingRoute.createGuideline({
    condition: "The patient says their visit is urgent",
    action: "Tell them to call the office immediately",
  });

  // Create lab results route
  const labResultsRoute = agent.createRoute({
    title: "Lab Results",
    description: "Retrieves the patient's lab results and explains them.",
    conditions: ["The patient wants to see their lab results"],
  });

  const l0 = labResultsRoute.initialState.transitionTo({
    toolState: getLabResults,
  });

  l0.target.transitionTo(
    {
      chatState:
        "Tell the patient that the results are not available yet, and to try again later",
    },
    "The lab results could not be found"
  );

  l0.target.transitionTo(
    {
      chatState:
        "Explain the lab results to the patient - that they are normal",
    },
    "The lab results are good - i.e., nothing to worry about"
  );

  l0.target.transitionTo(
    {
      chatState:
        "Present the results and ask them to call the office for clarifications on the results as you are not a doctor",
    },
    "The lab results are not good - i.e., there's an issue with the patient's health"
  );

  labResultsRoute.createGuideline({
    condition:
      "The patient presses you for more conclusions about the lab results",
    action:
      "Assertively tell them that you cannot help and they should call the office",
  });

  // Create observation for disambiguation
  const statusInquiry = agent.createObservation(
    "The patient asks to follow up on their visit, but it's not clear in which way"
  );

  // Use observation to disambiguate between the two routes
  statusInquiry.disambiguate([schedulingRoute, labResultsRoute]);

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

// Example usage
async function main() {
  const agent = await createHealthcareAgent();

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
  console.log("Observations:", agent.getObservations().length);

  // Print routes
  const routes = agent.getRoutes();
  for (const route of routes) {
    console.log("\n" + route.describe());
  }

  // Print observations
  console.log("\nObservations:");
  for (const obs of agent.getObservations()) {
    console.log(
      `- "${obs.description}" (disambiguates ${obs.getRoutes().length} routes)`
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { createHealthcareAgent };
