/**
 * Healthcare agent example demonstrating route-based
 * Updated for v2 architecture with session step management and schema-first data extraction
 */

import {
  Agent,
  type Tool,
  AnthropicProvider,
  END_ROUTE,
} from "../../src";

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

interface SatisfactionData {
  rating?: number;
  easeOfScheduling?: number;
  comments?: string;
}

// Tools

const getUpcomingSlots: Tool<HealthcareContext, unknown[], unknown, unknown> = {
  id: "get_upcoming_slots",
  name: "Available Appointment Slots",
  description: "Get upcoming appointment slots",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: () => {
    return { data: ["Monday 10 AM", "Tuesday 2 PM", "Wednesday 1 PM"] };
  },
};

const getLaterSlots: Tool<HealthcareContext, unknown[], unknown, unknown> = {
  id: "get_later_slots",
  name: "Extended Appointment Slots",
  description: "Get later appointment slots",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: () => {
    return { data: ["November 3, 11:30 AM", "November 12, 3 PM"] };
  },
};

const scheduleAppointment: Tool<
  HealthcareContext,
  unknown[],
  unknown,
  AppointmentData
> = {
  id: "schedule_appointment",
  name: "Appointment Scheduler",
  description: "Schedule an appointment with a healthcare provider",
  parameters: {
    type: "object",
    properties: {
      datetime: { type: "string", description: "Appointment date and time" },
    },
    required: ["datetime"],
  },
  handler: ({ data }) => {
    const appointment = data as Partial<AppointmentData>;
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
  },
};

const getLabResults: Tool<
  HealthcareContext,
  unknown[],
  unknown,
  LabResultsData
> = {
  id: "get_lab_results",
  name: "Lab Results Retriever",
  description: "Get lab test results",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: ({ context, data }) => {
    const labData = data as Partial<LabResultsData>;
    return {
      data: {
        report: `Lab results for ${labData?.testType || "general"} tests`,
        prognosis: "All tests are within the valid range",
        patientName: context.patientName,
      },
    };
  },
};

function createHealthcareAgent() {
  const provider = new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY || "test-key",
    model: "claude-sonnet-4-5",
  });

  const agent = new Agent<HealthcareContext>({
    name: "Healthcare Agent",
    description: "Is empathetic and calming to the patient.",
    identity:
      "I am the Healthcare Agent, a compassionate AI assistant dedicated to providing excellent patient care. With deep knowledge of medical procedures and a focus on patient comfort, I'm here to help you navigate your healthcare journey with empathy and expertise.",
    provider: provider,

    // Knowledge base with healthcare-specific information
    knowledgeBase: {
      medicalProcedures: {
        checkup: {
          duration: "30 minutes",
          preparation: "No special preparation needed",
          frequency: "Annual or as recommended by doctor",
        },
        consultation: {
          duration: "45-60 minutes",
          preparation: "Bring medical history and current medications",
          frequency: "As needed",
        },
        followup: {
          duration: "15-30 minutes",
          preparation: "Review previous visit notes",
          frequency: "2-4 weeks after initial treatment",
        },
      },
      insurancePolicies: {
        acceptedProviders: ["Mega Insurance", "Acme Insurance", "Blue Cross"],
        coverageTypes: ["HMO", "PPO", "Medicare"],
        requirements: {
          referral: "Required for specialist visits",
          copay: "$25 per visit",
          deductible: "$500 annual",
        },
      },
      emergencyGuidelines: [
        "Call 911 for life-threatening emergencies",
        "Go to nearest ER for severe symptoms",
        "Contact office for urgent but non-life-threatening issues",
        "Use telemedicine for minor concerns during office hours",
      ],
      patientResources: {
        patientPortal: "Available 24/7 for appointments and records",
        educationalMaterials: "Available in English, Spanish, and Portuguese",
        supportGroups: "Weekly sessions for chronic conditions",
      },
    },
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
  // NEW: Added onComplete to automatically transition to satisfaction survey after booking
  const schedulingRoute = agent.createRoute<AppointmentData>({
    title: "Schedule an Appointment",
    description: "Helps the patient find a time for their appointment.",
    conditions: ["The patient wants to schedule an appointment"],
    // Route-level identity for healthcare scheduling
    identity:
      "You are a compassionate healthcare scheduling assistant who helps patients book appointments. Be empathetic, prioritize urgent cases, and ensure patients feel supported throughout the process.",
    // Healthcare-specific terms
    terms: [
      {
        name: "HIPAA",
        description:
          "Health Insurance Portability and Accountability Act - protects patient privacy and medical records",
      },
      {
        name: "PHI",
        description:
          "Protected Health Information - any medical data that can identify a patient",
      },
      {
        name: "Telemedicine",
        description: "Remote healthcare consultation via video call or phone",
      },
    ],
    schema: {
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
    // NEW: Automatically collect feedback after successful scheduling
    onComplete: "Satisfaction Survey",
  });

  // Step 1: Collect appointment reason
  const collectReason = schedulingRoute.initialStep.nextStep({
    prompt: "Ask what the patient needs an appointment for",
    collect: ["appointmentReason"],
    skipIf: (data) => !!data.appointmentReason,
    when: "Patient hasn't specified reason for appointment yet",
  });

  // Step 2: Check urgency and show available slots
  const checkUrgency = collectReason.nextStep({
    prompt: "Check if this is urgent and show available slots",
    collect: ["urgency"],
    skipIf: (data) => !!data.urgency,
    requires: ["appointmentReason"],
    when: "Reason provided, now assess urgency level",
  });

  const showSlots = checkUrgency.nextStep({
    tools: [getUpcomingSlots],
  });

  // Step 3: Present available times
  const presentTimes = showSlots.nextStep({
    prompt: "List available times and ask which one works for them",
  });

  // Step 4: Collect preferred time and date
  const collectPreferences = presentTimes.nextStep({
    prompt: "Collect preferred time and date",
    collect: ["preferredTime", "preferredDate"],
    skipIf: (data) => !!data.preferredTime && !!data.preferredDate,
  });

  // Step 5: Confirm details and schedule
  const confirmDetails = collectPreferences.nextStep({
    prompt: "Confirm the details with the patient before scheduling",
    collect: ["appointmentType"],
    skipIf: (data) => !!data.appointmentType,
    requires: ["appointmentReason", "preferredTime", "preferredDate"],
  });

  const schedule = confirmDetails.nextStep({
    tools: [scheduleAppointment],
    requires: ["appointmentReason", "preferredTime", "preferredDate"],
    when: "All details confirmed, book the appointment",
  });

  const confirmation = schedule.nextStep({
    prompt: "Confirm the appointment has been scheduled",
  });

  confirmation.nextStep({
    step: END_ROUTE,
    when: "Appointment booked successfully",
  });

  // Alternative path: no times work - show later slots
  const laterSlots = presentTimes.nextStep({
    tools: [getLaterSlots],
  });

  laterSlots.nextStep({
    prompt: "List later times and ask if any of them works",
  });

  // If no times work at all, end route
  laterSlots
    .nextStep({
      prompt: "Ask the patient to call the office to schedule an appointment",
    })
    .nextStep({ step: END_ROUTE });

  schedulingRoute.createGuideline({
    condition: "The patient says their visit is urgent",
    action: "Tell them to call the office immediately",
  });

  // Create lab results route with data extraction schema
  const labResultsRoute = agent.createRoute<LabResultsData>({
    title: "Lab Results",
    description: "Retrieves the patient's lab results and explains them.",
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
  });

  // Step 1: Collect test information
  const collectTestInfo = labResultsRoute.initialStep.nextStep({
    prompt: "Ask what type of test results they want to see",
    collect: ["testType"],
    skipIf: (data) => !!data.testType,
  });

  // Step 2: Optional: collect test date
  const collectTestDate = collectTestInfo.nextStep({
    prompt: "Ask for the test date if they remember it",
    collect: ["testDate"],
    skipIf: (data) => !!data.testDate,
    requires: ["testType"],
  });

  // Step 3: Get lab results
  const getResults = collectTestDate.nextStep({
    tools: [getLabResults],
    requires: ["testType"],
  });

  // Step 4: Present results based on status
  const presentResults = getResults.nextStep({
    prompt: "Present the lab results and explain what they mean",
  });

  presentResults.nextStep({ step: END_ROUTE });

  labResultsRoute.createGuideline({
    condition:
      "The patient presses you for more conclusions about the lab results",
    action:
      "Assertively tell them that you cannot help and they should call the office",
  });

  // NEW: Satisfaction Survey route - collects feedback after appointment scheduling
  const satisfactionRoute = agent.createRoute<SatisfactionData>({
    title: "Satisfaction Survey",
    description: "Quick satisfaction survey after scheduling",
    conditions: ["Collect patient satisfaction feedback"],

    // Route-specific knowledge base for patient feedback
    knowledgeBase: {
      surveyBestPractices: [
        "Keep surveys short (3-5 questions maximum)",
        "Use clear rating scales (1-5 stars)",
        "Ask specific questions about what can be improved",
        "Always thank patients for their feedback",
        "Follow up on critical feedback within 24 hours",
      ],
      commonFeedbackThemes: {
        positive: ["Friendly staff", "Quick response", "Easy scheduling"],
        improvement: ["Wait times", "Communication", "Facility cleanliness"],
        urgent: ["Medical errors", "Billing issues", "Privacy concerns"],
      },
      npsCalculation: {
        promoters: "9-10 rating",
        passives: "7-8 rating",
        detractors: "0-6 rating",
        formula: "(Promoters - Detractors) / Total Responses * 100",
      },
      followUpActions: {
        critical: "Immediate review by practice manager",
        improvement: "Add to quarterly improvement plan",
        positive: "Share with staff as recognition",
      },
    },
    schema: {
      type: "object",
      properties: {
        rating: {
          type: "number",
          description: "Overall satisfaction rating 1-5",
        },
        easeOfScheduling: {
          type: "number",
          description: "Ease of scheduling process 1-5",
        },
        comments: {
          type: "string",
          description: "Optional feedback comments",
        },
      },
      required: ["rating"],
    },
  });

  const askRating = satisfactionRoute.initialStep.nextStep({
    prompt:
      "Ask for overall satisfaction rating from 1 to 5 with the scheduling experience",
    collect: ["rating"],
    skipIf: (data) => !!data.rating,
  });

  const askComments = askRating.nextStep({
    prompt: "Ask if they have any additional comments or feedback (optional)",
    collect: ["comments"],
  });

  const thankYou = askComments.nextStep({
    prompt:
      "Thank them for their feedback and confirm their appointment details one more time",
  });

  thankYou.nextStep({ step: END_ROUTE });

  // Global guidelines
  agent.createGuideline({
    condition: "The patient asks about insurance",
    action:
      "List the insurance providers we accept, and tell them to call the office for more details",
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

// Example usage with session step management
async function main() {
  const agent = createHealthcareAgent();

  // Session is automatically managed by the agent
  console.log("✨ Session ready:", agent.session.id);

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

  // Example conversation with session management
  console.log("\n=== EXAMPLE CONVERSATION ===");

  // Turn 1: Patient wants to follow up
  await agent.session.addMessage("user", "Hi, I need to follow up on my visit", "Patient");
  
  const response1 = await agent.respond({ 
    history: agent.session.getHistory() 
  });
  
  console.log("Patient: Hi, I need to follow up on my visit");
  console.log("Agent:", response1.message);
  console.log("Route:", response1.session?.currentRoute?.title);
  console.log("Data:", agent.session.getData<AppointmentData | LabResultsData>());

  await agent.session.addMessage("assistant", response1.message);

  // Turn 2: Patient specifies they want to schedule an appointment
  if (response1.session?.currentRoute?.title === "Schedule an Appointment") {
    const history2 = [
      ...history,
      {
        role: "user" as const,
        content: "I need to schedule a checkup for next week",
        name: "Patient",
      },
    ];

    const response2 = await agent.respond({ history: history2, session });
    console.log("\nPatient: I need to schedule a checkup for next week");
    console.log("Agent:", response2.message);
    console.log("Updated data:", response2.session?.data);
    console.log("Current step:", response2.session?.currentStep?.id);

    // Update session again
    session = response2.session!;

    // NEW: Check if route is complete - will auto-transition to satisfaction survey
    if (response2.isRouteComplete) {
      console.log("\n✓ Appointment scheduling complete!");
      console.log("Pending transition:", response2.session?.pendingTransition);
      console.log(
        "Next respond() will auto-transition to:",
        response2.session?.pendingTransition?.targetRouteId
      );
    }

    // Turn 3: Patient provides final details
    const history3 = [
      ...history2,
      {
        role: "user" as const,
        content: "Tuesday at 2 PM works for me.",
        name: "Patient",
      },
    ];

    const response3 = await agent.respond({ history: history3, session });
    console.log("\nPatient: Tuesday at 2 PM works for me.");
    console.log("Agent:", response3.message);
    console.log("Updated data:", response3.session?.data);
    console.log("Current step:", response3.session?.currentStep?.id);

    // Check for route completion
    if (response3.isRouteComplete) {
      console.log("\n✅ Appointment scheduling complete!");
      await sendAppointmentReminder(
        agent.getData(response3.session?.id) as unknown as AppointmentData
      );
    }
  }
}

/**
 * Mock function to send an appointment reminder.
 * @param data - The appointment data.
 */
async function sendAppointmentReminder(data: AppointmentData) {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 Sending Appointment Reminder...");
  console.log("=".repeat(60));
  console.log("Appointment Details:", JSON.stringify(data, null, 2));
  console.log(
    `   - Sending reminder for ${data.appointmentReason} on ${data.preferredDate} at ${data.preferredTime}.`
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("✨ Reminder sent!");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { createHealthcareAgent };

main().catch(console.error);
