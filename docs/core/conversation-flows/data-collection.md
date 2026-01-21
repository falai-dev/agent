# Agent-Level Schema-Driven Data Collection

@falai/agent implements a powerful agent-level schema-first approach to data collection, enabling type-safe, structured information extraction from natural conversations across all routes. Unlike traditional route-specific data collection, this system centralizes data schemas at the agent level while allowing routes to specify completion requirements.

## Overview

The agent-level data collection system provides:

- **Centralized JSON Schema**: Define comprehensive data structures at the agent level
- **Cross-Route Data Sharing**: Data collected by any route is available to all routes
- **Route Completion Logic**: Routes complete when their required fields are satisfied
- **Type-Safe Extraction**: Automatic mapping from AI responses to typed data
- **Natural Conversations**: AI handles information gathering conversationally
- **Validation & Enrichment**: Agent-level lifecycle hooks for data processing
- **Session Persistence**: Data survives across conversation turns and route transitions
- **Batch Data Collection**: Multiple steps can collect data in a single LLM call

## Data Collection Across Batched Steps

When multiple steps execute in a single batch, data collection works across all steps simultaneously.

### How Batch Data Collection Works

1. **Gather collect fields** - All `collect` fields from all steps in the batch are combined
2. **Single LLM call** - The combined prompt instructs the LLM to extract all fields
3. **Extract from response** - All specified fields are extracted from the LLM response
4. **Validate against schema** - Collected data is validated against the agent schema
5. **Update session** - All collected values are merged into session data

```typescript
// Batch with 3 steps, each collecting different fields
const batch = [
  { collect: ["name"] },
  { collect: ["email", "phone"] },
  { collect: ["preferences"] }
];

// Combined collection: ["name", "email", "phone", "preferences"]
// Single LLM response extracts all fields at once
```

### Pre-Extraction and Batch Determination

Pre-extraction happens **before** batch determination and directly impacts which steps can be batched:

```typescript
// User message: "I'm John, email john@example.com, I prefer dark mode"

// Phase 1: Pre-extraction
const preExtracted = {
  name: "John",
  email: "john@example.com",
  preferences: { theme: "dark" }
};

// Phase 2: Batch determination (with pre-extracted data merged)
// Step 1: collect: ["name"] → name exists → doesn't need input
// Step 2: collect: ["email"] → email exists → doesn't need input
// Step 3: collect: ["preferences"] → preferences exists → doesn't need input
// Result: All 3 steps batched together
```

### Pre-Extraction Configuration

Pre-extraction is automatic when routes define data fields:

```typescript
// Option 1: Route-level required fields
agent.createRoute({
  title: "Booking",
  requiredFields: ["hotel", "date", "guests"],
  // Pre-extraction enabled automatically
});

// Option 2: Route-level optional fields
agent.createRoute({
  title: "Booking",
  optionalFields: ["specialRequests"],
  // Pre-extraction enabled automatically
});

// Option 3: Steps with collect arrays
agent.createRoute({
  title: "Booking",
  steps: [
    { collect: ["hotel"] },  // Pre-extraction enabled automatically
  ]
});
```

### Batch Collection Example

```typescript
const response = await agent.respond(
  "I'm Alice, alice@example.com, and I want to book for 2 guests"
);

// Response includes all collected data
console.log(response.session.data);
// {
//   name: "Alice",
//   email: "alice@example.com",
//   guests: 2
// }

// Shows which steps executed
console.log(response.executedSteps);
// [
//   { id: "ask-name", routeId: "booking" },
//   { id: "ask-email", routeId: "booking" },
//   { id: "ask-guests", routeId: "booking" }
// ]
```

### Validation Across Batch

Data validation happens after collection for all fields:

```typescript
// Agent schema defines validation rules
const agent = new Agent({
  schema: {
    type: "object",
    properties: {
      email: { type: "string", format: "email" },
      guests: { type: "number", minimum: 1, maximum: 10 }
    }
  }
});

// If validation fails for any field:
const response = await agent.respond("Book for 100 guests");

// Response includes validation errors
if (response.stoppedReason === 'validation_error') {
  console.log(response.error);
  // {
  //   type: 'data_validation',
  //   message: 'Validation failed for 1 field(s): guests',
  //   details: [{ field: 'guests', message: 'Value exceeds maximum of 10' }]
  // }
}
```

### Partial Data Preservation

Even when validation fails, valid partial data is preserved:

```typescript
// User provides valid name but invalid email
const response = await agent.respond("I'm John, email: not-an-email");

// Valid data is still collected
console.log(response.session.data.name); // "John"

// Invalid data triggers validation error
console.log(response.stoppedReason); // "validation_error"
```

## Agent-Level Schema Definition

### Centralized Schema

```typescript
interface UserProfile {
  name: string;
  email: string;
  age: number;
  interests: string[];
  preferences: {
    notifications: boolean;
    theme: "light" | "dark";
  };
  // Additional fields for other routes
  supportTicketId?: string;
  issueType?: string;
  feedbackRating?: number;
  subscriptionTier?: "free" | "premium" | "enterprise";
}

// Define schema at agent level
const agent = new Agent<{}, UserProfile>({
  name: "User Management Agent",
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  
  // Comprehensive agent-level schema
  schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The user's full name",
      },
      email: {
        type: "string",
        format: "email",
        description: "Valid email address",
      },
      age: {
        type: "number",
        minimum: 13,
        maximum: 120,
        description: "Age in years",
      },
      interests: {
        type: "array",
        items: { type: "string" },
        description: "List of user interests",
      },
      preferences: {
        type: "object",
        properties: {
          notifications: { type: "boolean" },
          theme: {
            type: "string",
            enum: ["light", "dark"],
          },
        },
      },
      supportTicketId: { type: "string" },
      issueType: { type: "string" },
      feedbackRating: { type: "number", minimum: 1, maximum: 5 },
      subscriptionTier: { type: "string", enum: ["free", "premium", "enterprise"] }
    },
    required: ["name", "email"],
  }
});

// Routes specify required fields instead of schemas
const profileRoute = agent.createRoute({
  title: "User Profile Collection",
  requiredFields: ["name", "email", "age"],
  optionalFields: ["interests", "preferences"]
});

const supportRoute = agent.createRoute({
  title: "Support Ticket",
  requiredFields: ["name", "email", "issueType"],
  optionalFields: ["supportTicketId"]
});

const feedbackRoute = agent.createRoute({
  title: "Feedback Collection",
  requiredFields: ["name", "email", "feedbackRating"],
  optionalFields: ["subscriptionTier"]
});
```

### Advanced Schema Features

```typescript
const complexSchema = {
  type: "object",
  properties: {
    // Basic types
    name: { type: "string", minLength: 2, maxLength: 100 },

    // Email validation
    email: { type: "string", format: "email" },

    // Number constraints
    age: { type: "number", minimum: 0, maximum: 150 },

    // Arrays with constraints
    skills: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 10,
      uniqueItems: true,
    },

    // Nested objects
    address: {
      type: "object",
      properties: {
        street: { type: "string" },
        city: { type: "string" },
        zipCode: { type: "string", pattern: "^\\d{5}(-\\d{4})?$" },
      },
      required: ["street", "city"],
    },

    // Enums
    priority: {
      type: "string",
      enum: ["low", "medium", "high", "urgent"],
    },

    // Conditional schemas
    contactMethod: { type: "string", enum: ["email", "phone", "sms"] },
  },

  // Cross-field validation
  allOf: [
    {
      if: { properties: { contactMethod: { const: "phone" } } },
      then: { required: ["phoneNumber"] },
    },
  ],

  required: ["name", "email"],
};
```

## Step-Level Data Collection

### Basic Collection with Agent-Level Data

```typescript
const profileRoute = agent
  .createRoute({
    title: "Profile Collection",
    requiredFields: ["name", "email", "age"], // Required for route completion
    optionalFields: ["interests"], // Optional but helpful
    initialStep: {
      prompt:
        "Hi! I'm collecting some information to personalize your experience. What's your name?",
      collect: ["name"], // Maps to agent schema field
    },
  })
  .nextStep({
    prompt: "Thanks {{name}}! What's your email address?",
    collect: ["email"],
    requires: ["name"], // Must have name before collecting email
  })
  .nextStep({
    prompt: "What's your age?",
    collect: ["age"],
    requires: ["name", "email"],
  });

// Route completes when all required fields are collected
// Data is available to all other routes
```

### Multi-Field Collection

```typescript
const comprehensiveStep = {
  prompt: `
    Now I'd like to learn more about you. Please share:
    - Your age
    - Your main interests (comma-separated)
    - Whether you'd like email notifications (yes/no)
    - Your preferred theme (light/dark)
  `,
  collect: [
    "age", // Single field from agent schema
    "interests", // Array field from agent schema
    "preferences.notifications", // Nested field (dot notation)
    "preferences.theme", // Another nested field
  ],
  requires: ["name", "email"], // Prerequisites from agent data
};
```

### Conditional Collection

```typescript
const conditionalCollection = {
  prompt: "Would you like to set up notifications? (yes/no)",
  collect: ["preferences.notifications"],
  skipIf: (data) => data.preferences?.notifications !== undefined, // Skip if already collected
  requires: ["name", "email"], // Prerequisites from agent data
};
```

### Cross-Route Data Sharing

With agent-level data collection, routes can share data seamlessly:

```typescript
// User starts with profile collection
const response1 = await agent.respond("Hi, I'm John Doe, email john@example.com");
// Agent data: { name: "John Doe", email: "john@example.com" }

// User switches to support - data is already available
const response2 = await agent.respond("Actually, I need help with a technical issue");
// Support route can access name and email, only needs to collect issue details
// Support route: 2/3 required fields already satisfied

// User provides issue details
const response3 = await agent.respond("My account won't sync properly");
// Support route completes: { name: "John Doe", email: "john@example.com", issueType: "technical" }

// Later, user wants to give feedback
const response4 = await agent.respond("I want to rate my support experience - 5 stars");
// Feedback route completes immediately: already has name, email, and now rating
```

## Data Validation & Processing

### Agent-Level Lifecycle Hooks

```typescript
const agent = new Agent<{}, UserProfile>({
  name: "User Management Agent",
  schema: { /* agent schema */ },

  // Agent-level data validation (applies to all routes)
  hooks: {
    onDataUpdate: (newData, previousData) => {
      // Cross-field validation using complete agent data
      if (newData.email && newData.confirmEmail) {
        if (newData.email !== newData.confirmEmail) {
          throw new Error("Email addresses don't match");
        }
      }

      // Data enrichment based on agent-level data
      if (newData.name && !newData.displayName) {
        newData.displayName = newData.name.split(" ")[0]; // First name only
      }

      // Auto-set subscription tier based on email domain
      if (newData.email && !newData.subscriptionTier) {
        newData.subscriptionTier = newData.email.includes('@enterprise.com') ? 'enterprise' : 'free';
      }

      // Validate against agent schema
      const validation = agent.validateData(newData);
      if (!validation.valid) {
        throw new Error(`Data validation failed: ${validation.errors.map(e => e.message).join(', ')}`);
      }

      return newData;
    },
  },
});
```

### Route-Level Hooks

```typescript
const routeWithHooks = agent.createRoute({
  title: "Smart Collection",

  hooks: {
    onDataUpdate: async (newData, previousData) => {
      // External validation
      if (newData.email) {
        const isValid = await validateEmailExternally(newData.email);
        if (!isValid) {
          throw new Error("Email validation failed");
        }
      }

      // Data transformation
      if (newData.interests && typeof newData.interests === "string") {
        newData.interests = newData.interests.split(",").map((s) => s.trim());
      }

      return newData;
    },

    onContextUpdate: (newContext, previousContext) => {
      // React to context changes that affect data collection
      console.log("Context updated, may affect data validation rules");
    },
  },
});
```

## Data Flow & Persistence

### Session Data Management

```typescript
// Data flows through the session
const session = {
  data: {
    name: "John Doe",
    email: "john@example.com",
    age: 30,
  },
  dataByRoute: {
    "user-profile": {
      name: "John Doe",
      email: "john@example.com",
      age: 30,
    },
    preferences: {
      theme: "dark",
      notifications: true,
    },
  },
};
```

### Initial Data

```typescript
const routeWithInitialData = agent.createRoute({
  title: "Resume Collection",
  schema: userProfileSchema,

  // Pre-populate known data
  initialData: {
    name: "John Doe", // From authentication
    email: "john@example.com", // From user profile
    preferences: {
      theme: "dark", // From user settings
    },
  },

  initialStep: {
    prompt:
      "Welcome back {{name}}! Let's update your profile. How old are you?",
    collect: ["age"],
    skipIf: (data) => data.age !== undefined, // Skip if already known
  },
});
```

### Cross-Route Data Sharing

```typescript
// Route 1: Basic profile
const profileRoute = agent.createRoute({
  title: "Basic Profile",
  schema: {
    /* basic fields */
  },
});

// Route 2: Extended profile (can access data from Route 1)
const extendedRoute = agent.createRoute({
  title: "Extended Profile",
  schema: {
    /* extended fields */
  },
  initialData: (session) => ({
    // Access data from previous route
    ...session.dataByRoute?.["basic-profile"],
  }),
});
```

## AI Response Processing

### Structured Response Schema

The system automatically builds response schemas for AI:

```typescript
// For a step collecting ["name", "email"]
const responseSchema = {
  type: "object",
  properties: {
    message: { type: "string" }, // Standard response field
    name: {
      /* from route schema */
    },
    email: {
      /* from route schema */
    },
  },
  required: ["message"],
};
```

### Tool Integration

Data collection works seamlessly with tools:

```typescript
const toolEnhancedStep = {
  prompt: "What's your location? I'll help you find nearby services.",
  collect: ["location"],
  tools: ["geolocation-tool"], // Tools can enrich collected data
  finalize: async (context, data) => {
    if (data.location) {
      // Use collected location data
      const services = await findNearbyServices(data.location);
      // Update context or trigger next steps
    }
  },
};
```

## Error Handling & Recovery

### Validation Errors

```typescript
const robustRoute = agent.createRoute({
  title: "Robust Collection",

  hooks: {
    onDataUpdate: (newData, previousData) => {
      // Handle validation gracefully
      try {
        validateUserData(newData);
        return newData;
      } catch (error) {
        // Provide user-friendly error recovery
        if (error.message.includes("email")) {
          newData.emailError = "Please provide a valid email address";
        }
        return { ...previousData, ...newData };
      }
    },
  },
});
```

### Recovery Steps

```typescript
const recoveryRoute = agent
  .createRoute({
    title: "Error Recovery",

    initialStep: {
      prompt:
        "I noticed there was an issue with the information provided. Let's try again.",
      collect: ["correctedData"],
      when: "if there are validation errors in session data",
    },
  })
  .nextStep({
    prompt:
      "Thanks for the correction. Here's what I now have: {{correctedData}}",
    requires: ["correctedData"],
  });
```

## Advanced Patterns

### Progressive Collection

```typescript
const progressiveRoute = agent
  .createRoute({
    title: "Progressive Collection",

    // Start with minimal required data
    initialStep: {
      prompt: "Let's get started! What's your name and email?",
      collect: ["name", "email"],
    },

    // Add more fields as conversation progresses
  })
  .nextStep({
    prompt: "Great! Now tell me about your interests and preferences.",
    collect: ["interests", "preferences"],
    requires: ["name", "email"],
    skipIf: (data) => data.interests && data.preferences, // Skip if already have both
  });
```

### Conditional Schema Expansion

```typescript
const dynamicRoute = agent
  .createRoute({
    title: "Dynamic Collection",

    initialStep: {
      prompt: "Are you a business user or individual?",
      collect: ["userType"],
    },
  })
  .branch([
    {
      name: "business",
      step: {
        prompt: "For business users, I need company information...",
        collect: ["companyName", "industry", "companySize"],
        requires: ["userType"],
      },
    },
    {
      name: "individual",
      step: {
        prompt: "For individual users, tell me about your interests...",
        collect: ["personalInterests", "occupation"],
        requires: ["userType"],
      },
    },
  ]);
```

## Best Practices

### Schema Design

1. **Start Simple**: Begin with required fields only
2. **Progressive Enhancement**: Add optional fields as needed
3. **Clear Descriptions**: Document field purposes in schema
4. **Validation Rules**: Use JSON Schema constraints effectively

### Collection Strategy

1. **Logical Order**: Collect prerequisite data first
2. **Smart Skipping**: Skip already-known information
3. **Natural Flow**: Make conversations feel organic
4. **Error Recovery**: Plan for validation failures

### Performance

1. **Minimal Schemas**: Only define needed fields
2. **Efficient Hooks**: Avoid expensive operations in data hooks
3. **Caching**: Cache external validation results
4. **Batch Updates**: Group related field collections

### Testing

```typescript
// Test data collection
const mockSession = createSession();
const testData = {
  name: "Test User",
  email: "test@example.com",
};

// Simulate collection
const updatedSession = mergeCollected(mockSession, testData);

// Validate against schema
const isValid = validateAgainstSchema(testData, route.schema);
```

## Integration Examples

### Database Persistence

```typescript
const dbRoute = agent.createRoute({
  title: "Database-Backed Collection",

  hooks: {
    onDataUpdate: async (newData, previousData) => {
      // Auto-save to database
      if (newData.email && newData.email !== previousData.email) {
        await saveEmailToDatabase(newData.email);
      }
      return newData;
    },
  },
});
```

### External API Integration

```typescript
const apiRoute = agent.createRoute({
  title: "API-Enhanced Collection",

  hooks: {
    onDataUpdate: async (newData, previousData) => {
      // Enrich data with external APIs
      if (newData.zipCode && !newData.city) {
        const locationData = await geocodeZipCode(newData.zipCode);
        newData.city = locationData.city;
        newData.state = locationData.state;
      }
      return newData;
    },
  },
});
```

The schema-driven data collection system transforms natural conversations into structured, validated data while maintaining the flexibility and intelligence of AI-driven interactions.
