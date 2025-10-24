/**
 * Mixed Array Conditions Example
 * 
 * This example demonstrates using mixed array conditions that combine both
 * AI context strings and programmatic functions for sophisticated routing logic.
 * This hybrid approach provides the best of both worlds.
 * 
 * Key concepts:
 * - Array conditions combine strings and functions
 * - Strings provide AI context for decision making
 * - Functions provide programmatic validation
 * - AND logic for when conditions (all must be true)
 * - OR logic for skipIf conditions (any can trigger skip)
 */

import {
  Agent,
  GeminiProvider,
  type Guideline,
} from "../../src/index";

// Context for a healthcare appointment system
interface HealthcareContext {
  patientId: string;
  patientType: "new" | "returning" | "emergency";
  insuranceVerified: boolean;
  lastVisit?: string;
  medicalHistory: string[];
  currentSymptoms?: string[];
}

// Appointment data schema
interface AppointmentData {
  appointmentType?: "consultation" | "followup" | "emergency" | "routine";
  preferredDate?: string;
  preferredTime?: string;
  symptoms?: string;
  urgencyLevel?: "low" | "medium" | "high" | "critical";
  doctorPreference?: string;
  insuranceApproved?: boolean;
  appointmentConfirmed?: boolean;
}

const appointmentSchema = {
  type: "object",
  properties: {
    appointmentType: { type: "string", enum: ["consultation", "followup", "emergency", "routine"] },
    preferredDate: { type: "string" },
    preferredTime: { type: "string" },
    symptoms: { type: "string" },
    urgencyLevel: { type: "string", enum: ["low", "medium", "high", "critical"] },
    doctorPreference: { type: "string" },
    insuranceApproved: { type: "boolean" },
    appointmentConfirmed: { type: "boolean" },
  },
};

// Create agent with mixed array condition examples
const agent = new Agent<HealthcareContext, AppointmentData>({
  name: "HealthcareBot",
  description: "A healthcare appointment bot using mixed condition logic",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY || "demo-key",
    model: "models/gemini-2.5-flash",
  }),
  context: {
    patientId: "pat_12345",
    patientType: "returning",
    insuranceVerified: true,
    lastVisit: "2024-09-15",
    medicalHistory: ["hypertension", "diabetes"],
    currentSymptoms: ["headache", "fatigue"],
  },
  schema: appointmentSchema,
});

// Guidelines with mixed array conditions
const guidelines: Guideline<HealthcareContext, AppointmentData>[] = [
  {
    // Mixed condition: AI context + programmatic validation
    condition: [
      "Patient mentions severe pain or emergency symptoms",
      (ctx) => ctx.data?.urgencyLevel === "critical" || ctx.data?.urgencyLevel === "high"
    ],
    action: "Immediately escalate to emergency protocols and offer urgent appointment slots",
    tags: ["emergency", "urgent"],
  },
  {
    // Mixed condition: AI understanding + insurance check
    condition: [
      "Patient asks about costs or insurance coverage",
      (ctx) => ctx.context?.insuranceVerified === false
    ],
    action: "Provide insurance verification assistance and cost estimates",
    tags: ["insurance", "billing"],
  },
  {
    // Mixed condition: AI context + medical history check
    condition: [
      "Patient mentions chronic condition management",
      (ctx) => (ctx.context?.medicalHistory?.length || 0) > 0
    ],
    action: "Reference their medical history and suggest appropriate follow-up care",
    tags: ["chronic-care", "history"],
  },
];

// Add guidelines to agent
guidelines.forEach(guideline => agent.createGuideline(guideline));

// Route 1: Emergency Appointment - Mixed array condition
agent.createRoute({
  title: "Emergency Appointment",
  description: "Handle urgent medical appointments",
  // Mixed when condition: AI context + programmatic urgency check
  when: [
    "Patient has urgent medical needs or emergency symptoms",
    "Patient mentions severe pain, difficulty breathing, or critical symptoms",
    (ctx) => ctx.data?.urgencyLevel === "critical" || ctx.data?.urgencyLevel === "high"
  ],
  // Skip if already confirmed or if it's a routine matter
  skipIf: [
    "appointment already confirmed or patient needs routine care",
    (ctx) => ctx.data?.appointmentConfirmed === true,
    (ctx) => ctx.data?.urgencyLevel === "low"
  ],
  requiredFields: ["appointmentType", "symptoms", "urgencyLevel"],
  steps: [
    {
      id: "assess_emergency",
      description: "Assess emergency situation",
      prompt: "I understand this is urgent. Can you describe your symptoms so I can find the earliest available appointment?",
      collect: ["symptoms", "urgencyLevel"],
      // Mixed when condition for step
      when: [
        "need to understand the urgency of the situation",
        (ctx) => !ctx.data?.symptoms || !ctx.data?.urgencyLevel
      ],
    },
    {
      id: "emergency_scheduling",
      description: "Schedule emergency appointment",
      prompt: "Based on your symptoms, I'm scheduling you for an emergency appointment. Let me find the next available slot.",
      requires: ["symptoms", "urgencyLevel"],
    },
  ],
});

// Route 2: Follow-up Appointment - Mixed array condition
agent.createRoute({
  title: "Follow-up Appointment",
  description: "Schedule follow-up appointments for existing patients",
  // Mixed when condition: AI context + patient history check
  when: [
    "Patient wants to schedule a follow-up appointment",
    "Patient mentions previous visit or ongoing treatment",
    (ctx) => ctx.context?.patientType === "returning",
    (ctx) => !!ctx.context?.lastVisit
  ],
  // Skip if it's clearly an emergency or new patient
  skipIf: [
    "patient has emergency symptoms or is a new patient",
    (ctx) => ctx.context?.patientType === "new",
    (ctx) => ctx.data?.urgencyLevel === "critical"
  ],
  requiredFields: ["appointmentType", "preferredDate"],
  optionalFields: ["preferredTime", "doctorPreference"],
  steps: [
    {
      id: "review_history",
      description: "Review patient history",
      prompt: "I see you were last here on your previous visit. How are you feeling since then?",
      // Mixed when condition: AI context + history availability
      when: [
        "need to understand patient's current condition",
        (ctx) => !!ctx.context?.lastVisit
      ],
    },
    {
      id: "schedule_followup",
      description: "Schedule follow-up appointment",
      prompt: "When would you like to schedule your follow-up appointment?",
      collect: ["preferredDate", "preferredTime"],
      // Mixed skipIf: AI context + data check
      skipIf: [
        "appointment details already provided",
        (ctx) => !!ctx.data?.preferredDate && !!ctx.data?.preferredTime
      ],
    },
  ],
});

// Route 3: New Patient Onboarding - Mixed array condition
agent.createRoute({
  title: "New Patient Onboarding",
  description: "Handle new patient registration and first appointment",
  // Mixed when condition: AI context + patient type check
  when: [
    "Patient is new to the practice or needs to register",
    "Patient mentions first visit or being a new patient",
    (ctx) => ctx.context?.patientType === "new"
  ],
  // Skip if patient is already established
  skipIf: [
    "patient is already registered and has visit history",
    (ctx) => ctx.context?.patientType === "returning",
    (ctx) => (ctx.context?.medicalHistory?.length || 0) > 0
  ],
  requiredFields: ["appointmentType"],
  optionalFields: ["symptoms", "doctorPreference"],
  steps: [
    {
      id: "welcome_new_patient",
      description: "Welcome new patient",
      prompt: "Welcome to our practice! As a new patient, I'll help you get registered and schedule your first appointment.",
      // Mixed when condition for welcoming
      when: [
        "patient needs welcome and orientation",
        (ctx) => ctx.context?.patientType === "new"
      ],
    },
    {
      id: "collect_appointment_info",
      description: "Collect appointment information",
      prompt: "What type of appointment would you like to schedule?",
      collect: ["appointmentType"],
      // Mixed skipIf: AI context + data availability
      skipIf: [
        "appointment type already specified",
        (ctx) => !!ctx.data?.appointmentType
      ],
    },
  ],
});

// Route 4: Insurance Verification - Mixed array condition
agent.createRoute({
  title: "Insurance Verification",
  description: "Handle insurance verification and approval",
  // Mixed when condition: AI context + insurance status check
  when: [
    "Patient asks about insurance coverage or verification",
    "Patient mentions insurance concerns or billing questions",
    (ctx) => ctx.context?.insuranceVerified === false,
    (ctx) => !ctx.data?.insuranceApproved
  ],
  // Skip if insurance is already verified
  skipIf: [
    "insurance already verified and approved",
    (ctx) => ctx.context?.insuranceVerified === true,
    (ctx) => ctx.data?.insuranceApproved === true
  ],
  optionalFields: ["insuranceApproved"],
  steps: [
    {
      id: "verify_insurance",
      description: "Verify insurance coverage",
      prompt: "Let me verify your insurance coverage for this appointment.",
      collect: ["insuranceApproved"],
      // Mixed when condition: AI context + verification needed
      when: [
        "insurance verification is required",
        (ctx) => ctx.context?.insuranceVerified === false
      ],
    },
  ],
});

// Route 5: Routine Appointment - Mixed array condition
agent.createRoute({
  title: "Routine Appointment",
  description: "Schedule routine check-ups and preventive care",
  // Mixed when condition: AI context + routine care indicators
  when: [
    "Patient wants routine check-up or preventive care",
    "Patient mentions annual exam, screening, or wellness visit",
    (ctx) => ctx.data?.urgencyLevel === "low" || !ctx.data?.urgencyLevel,
    (ctx) => !ctx.context?.currentSymptoms || ctx.context.currentSymptoms.length === 0
  ],
  // Skip if urgent care is needed
  skipIf: [
    "patient has urgent symptoms or emergency needs",
    (ctx) => ctx.data?.urgencyLevel === "high" || ctx.data?.urgencyLevel === "critical",
    (ctx) => (ctx.context?.currentSymptoms?.length || 0) > 2
  ],
  requiredFields: ["appointmentType", "preferredDate"],
  steps: [
    {
      id: "routine_scheduling",
      description: "Schedule routine appointment",
      prompt: "I'd be happy to help you schedule a routine appointment. When would work best for you?",
      collect: ["preferredDate", "preferredTime"],
      // Mixed when condition: AI context + scheduling needs
      when: [
        "need to find convenient appointment time",
        (ctx) => !ctx.data?.preferredDate
      ],
    },
  ],
});

// Route 6: Appointment Confirmation - Mixed array condition
agent.createRoute({
  title: "Appointment Confirmation",
  description: "Confirm and finalize appointment details",
  // Mixed when condition: AI context + completion readiness
  when: [
    "Ready to confirm appointment with all details collected",
    "Patient has provided necessary information for scheduling",
    (ctx) => !!ctx.data?.appointmentType && !!ctx.data?.preferredDate,
    (ctx) => !ctx.data?.appointmentConfirmed
  ],
  // Skip if already confirmed or missing critical info
  skipIf: [
    "appointment already confirmed or missing required information",
    (ctx) => ctx.data?.appointmentConfirmed === true,
    (ctx) => !ctx.data?.appointmentType
  ],
  steps: [
    {
      id: "confirm_appointment",
      description: "Confirm appointment details",
      prompt: "Perfect! Let me confirm your appointment details and send you a confirmation.",
      requires: ["appointmentType", "preferredDate"],
      // Mixed when condition: AI context + confirmation readiness
      when: [
        "all required information collected for confirmation",
        (ctx) => !!ctx.data?.appointmentType && !!ctx.data?.preferredDate
      ],
    },
  ],
});

// Demonstration function
async function demonstrateMixedArrayConditions() {
  console.log("=== Mixed Array Conditions Demo ===\n");
  console.log("This demo shows how mixed conditions combine AI context with programmatic logic.\n");

  const testScenarios = [
    {
      name: "Emergency Situation",
      context: { 
        patientType: "returning" as const, 
        insuranceVerified: true,
        currentSymptoms: ["chest pain", "shortness of breath"]
      },
      data: { urgencyLevel: "critical" as const },
      message: "I'm having severe chest pain and trouble breathing",
      expectedRoute: "Emergency Appointment"
    },
    {
      name: "Follow-up Visit",
      context: { 
        patientType: "returning" as const, 
        insuranceVerified: true,
        lastVisit: "2024-10-01",
        medicalHistory: ["diabetes"]
      },
      message: "I need to schedule a follow-up for my diabetes check",
      expectedRoute: "Follow-up Appointment"
    },
    {
      name: "New Patient",
      context: { 
        patientType: "new" as const, 
        insuranceVerified: false,
        medicalHistory: []
      },
      message: "Hi, I'm new to this practice and need to schedule my first appointment",
      expectedRoute: "New Patient Onboarding"
    },
    {
      name: "Insurance Issue",
      context: { 
        patientType: "returning" as const, 
        insuranceVerified: false
      },
      message: "I'm not sure if my insurance covers this appointment",
      expectedRoute: "Insurance Verification"
    },
    {
      name: "Routine Check-up",
      context: { 
        patientType: "returning" as const, 
        insuranceVerified: true,
        currentSymptoms: []
      },
      data: { urgencyLevel: "low" as const },
      message: "I'd like to schedule my annual physical exam",
      expectedRoute: "Routine Appointment"
    },
    {
      name: "Ready for Confirmation",
      context: { 
        patientType: "returning" as const, 
        insuranceVerified: true
      },
      data: { 
        appointmentType: "routine" as const, 
        preferredDate: "2024-11-15",
        preferredTime: "10:00 AM"
      },
      message: "Yes, that appointment time works for me",
      expectedRoute: "Appointment Confirmation"
    },
  ];

  for (const scenario of testScenarios) {
    console.log(`🔍 Testing: ${scenario.name}`);
    console.log(`📝 Message: "${scenario.message}"`);
    
    // Create agent with specific context for this scenario
    const testAgent = new Agent<HealthcareContext, AppointmentData>({
      name: "TestHealthBot",
      description: "Test bot for mixed conditions",
      provider: new GeminiProvider({
        apiKey: process.env.GEMINI_API_KEY || "demo-key",
        model: "models/gemini-2.5-flash",
      }),
      context: {
        patientId: "test_patient",
        medicalHistory: [],
        ...scenario.context,
      },
      schema: appointmentSchema,
    });

    // Add guidelines to test agent
    guidelines.forEach(guideline => testAgent.createGuideline(guideline));

    try {
      const response = await testAgent.respond({
        history: [
          {
            role: "user",
            content: scenario.message,
            name: "Patient",
          },
        ],
        session: scenario.data ? { 
          id: "test-session", 
          data: scenario.data,
        } : undefined,
      });

      console.log(`🎯 Routed to: ${response.session?.currentRoute?.title || "No route"}`);
      console.log(`✅ Expected: ${scenario.expectedRoute}`);
      console.log(`🤖 Response: ${response.message.substring(0, 100)}...`);
      console.log();
    } catch (error) {
      console.log(`❌ Error: ${error}`);
      console.log();
    }
  }

  console.log("💡 Key Benefits of Mixed Array Conditions:");
  console.log("   - Combines AI understanding with programmatic validation");
  console.log("   - Flexible routing that adapts to both context and data");
  console.log("   - Natural language processing enhanced by business logic");
  console.log("   - Robust decision making with multiple validation layers");
  console.log("   - Best of both worlds: AI context + precise logic");
}

// Run demonstration
async function main() {
  try {
    await demonstrateMixedArrayConditions();
  } catch (error) {
    console.error("Error:", error);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { agent, demonstrateMixedArrayConditions };