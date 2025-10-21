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
  Tool,
  ValidationError,
  type Term,
  type Guideline,
  type RouteOptions,
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

// Define tools using unified Tool interface
const getInsuranceProvidersTool: Tool<HealthcareContext, HealthcareData> = {
  id: "healthcare_insurance_providers",
  description: "Retrieves list of accepted insurance providers",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (context, args) => {
    return {
      data: "Available insurance providers: MegaCare Insurance, HealthFirst, WellnessPlus",
    };
  },
};

const getAvailableSlotsTool: Tool<HealthcareContext, HealthcareData> = {
  id: "healthcare_available_slots",
  description: "Gets available appointment slots",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (context, args) => {
    return {
      data: "Available slots: Oct 20 at 10:00 AM, Oct 20 at 2:00 PM, Oct 21 at 1:00 PM",
    };
  },
};

const getLabResultsTool: Tool<HealthcareContext, HealthcareData> = {
  id: "healthcare_lab_results",
  description: "Retrieves patient lab results",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (toolContext, args) => {
    // Tools can access collected data and context
    if (toolContext.data?.testType) {
      return {
        data: `${toolContext.data.testType} results for ${toolContext.context.patientName}: All values within normal range`,
      };
    }

    return {
      data: `Lab results for ${toolContext.context.patientName}: All values within normal range`,
    };
  },
};

const scheduleAppointmentTool: Tool<HealthcareContext, HealthcareData> = {
  id: "healthcare_schedule_appointment",
  description: "Schedules patient appointments",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (context, args) => {
    // Tools access collected appointment data
    if (!context.data?.preferredDate || !context.data?.preferredTime) {
      return { data: "Please provide appointment details" };
    }

    return {
      data: `Appointment scheduled for ${context.data.preferredDate} at ${context.data.preferredTime}`,
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

const routes = [
  {
    id: "route_schedule_appointment",
    title: "Schedule Appointment",
    description: "Helps the patient schedule an appointment",
    conditions: ["The patient wants to schedule an appointment"],
    // NEW: Required fields for route completion (instead of schema)
    requiredFields: ["appointmentType", "preferredDate", "preferredTime"],
    // NEW: Optional fields that enhance the experience
    optionalFields: ["symptoms", "urgency"],
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
        skipIf: (data: Partial<HealthcareData>) =>
          data.appointmentType === "checkup", // Skip for checkups
      },
      {
        id: "schedule_appointment",
        description: "Schedule the appointment",
        prompt: "I'll schedule your appointment now.",
        tools: ["healthcare_schedule_appointment"], // Reference by ID
        requires: ["preferredDate", "preferredTime"],
        prepare: "healthcare_insurance_providers", // Reference by ID
        finalize: "finalize_appointment", // Reference by ID - will be registered later
      },
    ],
    tools: ["healthcare_available_slots"], // Reference by ID
  },
  {
    id: "route_check_lab_results",
    title: "Check Lab Results",
    description: "Retrieves and explains patient lab results",
    conditions: ["The patient wants to see their lab results"],
    // NEW: Required fields for route completion
    requiredFields: ["testType"],
    // NEW: Optional fields
    optionalFields: ["testDate", "resultsNeeded"],
    guidelines: [
      {
        condition: "The patient presses for more conclusions about results",
        action:
          "Assertively tell them they should call the office to speak with a doctor",
        tags: ["escalation"],
      },
    ],
    tools: ["healthcare_lab_results"], // Reference by ID
  },
  {
    title: "General Healthcare Questions",
    description: "Answer general healthcare questions",
    conditions: ["Patient asks general healthcare questions"],
    // No required fields - conversational Q&A
  },
];

// Define a unified data schema for all healthcare interactions
interface HealthcareData extends AppointmentData, LabData {}

const healthcareSchema = {
  type: "object",
  properties: {
    // Appointment fields
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
    // Lab fields
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
};

// Create the fully configured agent with agent-level schema
const agent = new Agent<HealthcareContext, HealthcareData>({
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
  // NEW: Agent-level schema
  schema: healthcareSchema,
  // Declarative initialization
  terms,
  guidelines,
});

// Demonstrate different tool registration approaches

// Method 1: Register tools for ID-based reference in routes
agent.tool.registerMany([
  getInsuranceProvidersTool,
  getAvailableSlotsTool,
  getLabResultsTool,
  scheduleAppointmentTool,
]);

// Method 2: Create and register specialized tools
const appointmentValidator = agent.tool.createValidation({
  id: "validate_appointment",
  fields: ["appointmentType", "preferredDate", "preferredTime"] as const,
  validator: async (context, data) => {
    const errors: ValidationError[] = [];
    if (!data.appointmentType) errors.push({ 
      field: "appointmentType", 
      value: data.appointmentType,
      message: "Appointment type is required",
      schemaPath: "appointmentType"
    });
    if (!data.preferredDate) errors.push({ 
      field: "preferredDate", 
      value: data.preferredDate,
      message: "Preferred date is required",
      schemaPath: "preferredDate"
    });
    if (!data.preferredTime) errors.push({ 
      field: "preferredTime", 
      value: data.preferredTime,
      message: "Preferred time is required",
      schemaPath: "preferredTime"
    });
    
    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    };
  },
});

// Method 3: Create data enrichment tool
const patientDataEnricher = agent.tool.createDataEnrichment({
  id: "enrich_patient_data",
  fields: ["appointmentType", "symptoms"] as const,
  enricher: async (context, data) => {
    // Add urgency classification based on symptoms - return fields that exist in HealthcareData
    const urgentKeywords = ["chest pain", "difficulty breathing", "severe", "emergency"];
    const hasUrgentSymptoms = data.symptoms && urgentKeywords.some(keyword => 
      data.symptoms!.toLowerCase().includes(keyword)
    );
    
    return {
      urgency: hasUrgentSymptoms ? "high" : "medium", // This matches the urgency field in HealthcareData
    };
  },
});

// Method 4: Create tool using tool.create()
const finalizeAppointmentTool = agent.tool.create({
  id: "finalize_appointment",
  description: "Complete the appointment booking process",
  parameters: { type: "object", properties: {} },
  handler: async (context, args) => {
    console.log(`✅ Appointment finalized for ${context.context.patientName}`);
    console.log(`📅 Details: ${JSON.stringify(context.data, null, 2)}`);

    // Could send confirmation email, update calendar, etc.
    return {
      data: `Appointment confirmed for ${context.context.patientName}`,
    };
  },
});

// Add routes after tools are registered
routes.forEach((route: any) => {
  agent.createRoute(route);
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
  // Session is automatically managed by the agent
  console.log("✨ Session ready:", agent.session.id);

  // Turn 1 - Agent responds and routes to appropriate flow
  console.log("🔄 Turn 1: Initial inquiry");
  await agent.session.addMessage("user", "Hi, I need to follow up on my recent visit", "Alice");
  
  const response1 = await agent.respond({ 
    history: agent.session.getHistory() 
  });
  
  console.log("🤖 Agent:", response1.message);
  console.log("🛤️  Route chosen:", response1.session?.currentRoute?.title);

  await agent.session.addMessage("assistant", response1.message);

  // Turn 2 - User provides more details
  console.log("\n🔄 Turn 2: Providing appointment details");
  await agent.session.addMessage("user", "I need a checkup next Tuesday at 2 PM", "Alice");

  const response2 = await agent.respond({ 
    history: agent.session.getHistory() 
  });
  
  console.log("🤖 Agent:", response2.message);
  console.log("📊 Collected data:", agent.session.getData());
  console.log("📍 Current step:", response2.session?.currentStep?.id);

  await agent.session.addMessage("assistant", response2.message);

  // Turn 3 - Continue the conversation flow
  console.log("\n🔄 Turn 3: Continuing appointment booking");
  
  await agent.session.addMessage("user", "I'm feeling a bit anxious about the visit", "Alice");

  const response3 = await agent.respond({ 
    history: agent.session.getHistory() 
  });
  
  console.log("🤖 Agent:", response3.message);
  console.log("📊 Updated data:", agent.session.getData());
  console.log("📍 Current step:", response3.session?.currentStep?.id);
  
  await agent.session.addMessage("assistant", response3.message);

  // Check for route completion
  if (response3.isRouteComplete && response3.session) {
    console.log("\n✅ Appointment scheduling complete!");
    await sendAppointmentConfirmation(
      agent.getCollectedData() as HealthcareData
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
 * @param data - The healthcare data.
 */
async function sendAppointmentConfirmation(data: HealthcareData) {
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
