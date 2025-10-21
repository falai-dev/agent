/**
 * Schema-Driven Data Extraction Example
 *
 * This example demonstrates how to use JSON Schema to define data contracts
 * and extract structured data reliably from conversations.
 *
 * Key concepts:
 * - Schema-first data definition
 * - Type-safe data extraction
 * - Automatic validation
 * - SkipIf conditions for smart flow control
 */

import { Agent, GeminiProvider, type Tool } from "../../src/index";

// Define the data structure we want to collect
interface UserProfileData {
  name: string;
  email: string;
  age: number;
  interests: string[];
  preferredContact: "email" | "phone" | "sms";
  newsletterOptIn: boolean;
}

// Define a tool that uses the collected data - using unified Tool interface
const saveUserProfileTool: Tool<unknown, UserProfileData> = {
  id: "save_user_profile",
  description: "Save the collected user profile information",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (context, args) => {
    console.log("Saving user profile:", context.data);

    // Simulate saving to database
    console.log("Profile data:", context.data);

    return {
      data: `Profile saved successfully! Welcome ${context.data?.name}!`,
    };
  },
};

// Define the schema for data validation and extraction
const userProfileSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "The user's full name",
      minLength: 2,
      maxLength: 100,
    },
    email: {
      type: "string",
      format: "email",
      description: "The user's email address",
    },
    age: {
      type: "number",
      description: "The user's age in years",
      minimum: 13,
      maximum: 120,
    },
    interests: {
      type: "array",
      items: { type: "string" },
      description: "User's interests and hobbies",
      minItems: 1,
      maxItems: 10,
    },
    preferredContact: {
      type: "string",
      enum: ["email", "phone", "sms"],
      description: "Preferred contact method",
      default: "email",
    },
    newsletterOptIn: {
      type: "boolean",
      description: "Whether user wants to receive newsletters",
      default: false,
    },
  },
  required: ["name", "email"],
};

// Create the agent with agent-level schema
const agent = new Agent<unknown, UserProfileData>({
  name: "ProfileBot",
  description:
    "A bot that collects user profile information using schema-driven extraction",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY!,
    model: "models/gemini-2.5-flash",
  }),
  // NEW: Agent-level schema definition
  schema: userProfileSchema,
});

// Add tool using unified interface
agent.addTool(saveUserProfileTool);

// Create a route that collects profile information step by step
agent.createRoute({
  title: "User Profile Collection",
  description: "Collect comprehensive user profile information",
  // NEW: Required fields for route completion (instead of schema)
  requiredFields: ["name", "email"],
  // NEW: Optional fields that enhance the experience
  optionalFields: ["age", "interests", "preferredContact", "newsletterOptIn"],
  // Use sequential steps for a linear flow with smart skipIf conditions
  steps: [
    {
      id: "ask_name",
      description: "Ask for user's name",
      prompt: "Hi! I'd like to create a profile for you. What's your name?",
      collect: ["name"],
      skipIf: (data: Partial<UserProfileData>) => !!data.name,
    },
    {
      id: "ask_email",
      description: "Ask for user's email",
      prompt: "What's your email address?",
      collect: ["email"],
      requires: ["name"],
      skipIf: (data: Partial<UserProfileData>) => !!data.email,
    },
    {
      id: "ask_age",
      description: "Ask for user's age (optional)",
      prompt: "How old are you? (optional)",
      collect: ["age"],
      requires: ["name", "email"],
      skipIf: (data: Partial<UserProfileData>) => data.age !== undefined,
    },
    {
      id: "ask_interests",
      description: "Ask for user's interests (optional)",
      prompt: "What are your interests or hobbies? (optional)",
      collect: ["interests"],
      requires: ["name", "email"],
      skipIf: (data: Partial<UserProfileData>) =>
        !!(data.interests && data.interests.length > 0),
    },
    {
      id: "ask_contact_preference",
      description: "Ask for preferred contact method",
      prompt: "What's your preferred contact method?",
      collect: ["preferredContact"],
      requires: ["name", "email"],
      skipIf: (data: Partial<UserProfileData>) => !!data.preferredContact,
    },
    {
      id: "ask_newsletter",
      description: "Ask about newsletter subscription",
      prompt: "Would you like to subscribe to our newsletter?",
      collect: ["newsletterOptIn"],
      requires: ["name", "email"],
      skipIf: (data: Partial<UserProfileData>) =>
        data.newsletterOptIn !== undefined,
    },
    {
      id: "save_profile",
      description: "Save the collected profile",
      prompt:
        "Thanks for providing your information! Let me save your profile.",
      tools: ["save_user_profile"], // Reference by ID
      requires: ["name", "email"],
    },
  ],
});

// Example conversation demonstrating schema-driven extraction
async function demonstrateSchemaExtraction() {
  console.log("=== Schema-Driven Data Extraction Demo ===\n");

  // First message - user provides name and email
  console.log("User: Hi, I'm John Doe and my email is john@example.com");
  const response1 = await agent.respond({
    history: [
      {
        role: "user",
        content: "Hi, I'm John Doe and my email is john@example.com",
        name: "John",
      },
    ],
  });

  console.log("Bot:", response1.message);
  console.log(
    "Collected data:",
    JSON.stringify(response1.session?.data as Partial<UserProfileData>, null, 2)
  );

  // Second message - user provides more information
  console.log(
    "\nUser: I'm 30 years old and I like hiking, reading, and photography"
  );
  const response2 = await agent.respond({
    history: [
      {
        role: "user",
        content: "Hi, I'm John Doe and my email is john@example.com",
        name: "John",
      },
      {
        role: "assistant",
        content: response1.message,
      },
      {
        role: "user",
        content: "I'm 30 years old and I like hiking, reading, and photography",
        name: "John",
      },
    ],
    session: response1.session,
  });

  console.log("Bot:", response2.message);
  console.log(
    "Collected data:",
    JSON.stringify(response2.session?.data as Partial<UserProfileData>, null, 2)
  );

  // Third message - user provides contact preference and completes profile
  console.log(
    "\nUser: Please contact me by email and yes, I'd like the newsletter"
  );
  const response3 = await agent.respond({
    history: [
      {
        role: "user",
        content: "Hi, I'm John Doe and my email is john@example.com",
        name: "John",
      },
      {
        role: "assistant",
        content: response1.message,
      },
      {
        role: "user",
        content: "I'm 30 years old and I like hiking, reading, and photography",
        name: "John",
      },
      {
        role: "assistant",
        content: response2.message,
      },
      {
        role: "user",
        content: "Please contact me by email and yes, I'd like the newsletter",
        name: "John",
      },
    ],
    session: response2.session,
  });

  console.log("Bot:", response3.message);
  console.log(
    "Final collected data:",
    JSON.stringify(response3.session?.data as Partial<UserProfileData>, null, 2)
  );
  console.log("Route complete:", response3.isRouteComplete);
}

// Demonstrate with a single comprehensive message
async function demonstrateSmartSkipping() {
  console.log("\n=== Smart Skipping Demo ===\n");

  console.log("User provides everything in one message:");
  console.log(
    "User: I'm Sarah Johnson, sarah@email.com, 28 years old. I enjoy cooking, travel, and music. Contact me by phone and yes to newsletter."
  );

  const response = await agent.respond({
    history: [
      {
        role: "user",
        content:
          "I'm Sarah Johnson, sarah@email.com, 28 years old. I enjoy cooking, travel, and music. Contact me by phone and yes to newsletter.",
        name: "Sarah",
      },
    ],
  });

  console.log("Bot:", response.message);
  console.log(
    "Collected data:",
    JSON.stringify(response.session?.data as Partial<UserProfileData>, null, 2)
  );
  console.log("Route complete:", response.isRouteComplete);
}

// Run the demonstrations
async function main() {
  try {
    await demonstrateSchemaExtraction();
    await demonstrateSmartSkipping();
  } catch (error) {
    console.error("Error:", error);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
