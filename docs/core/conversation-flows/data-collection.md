# Schema-Driven Data Collection

@falai/agent implements a powerful schema-first approach to data collection, enabling type-safe, structured information extraction from natural conversations. Unlike traditional form-filling, this system uses AI to naturally gather information while maintaining data integrity.

## Overview

The data collection system provides:

- **JSON Schema Contracts**: Define data structures upfront with validation
- **Type-Safe Extraction**: Automatic mapping from AI responses to typed data
- **Natural Conversations**: AI handles information gathering conversationally
- **Validation & Enrichment**: Lifecycle hooks for data processing
- **Session Persistence**: Data survives across conversation turns

## Schema Definition

### Basic Schema

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
}

const userProfileRoute = agent.createRoute<UserProfile>({
  title: "User Profile Collection",
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
    },
    required: ["name", "email"],
  },
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

### Basic Collection

```typescript
const profileRoute = agent
  .createRoute({
    title: "Profile Collection",
    schema: userProfileSchema,
    initialStep: {
      prompt:
        "Hi! I'm collecting some information to personalize your experience. What's your name?",
      collect: ["name"], // Maps to schema field
    },
  })
  .nextStep({
    prompt: "Thanks {{name}}! What's your email address?",
    collect: ["email"],
    requires: ["name"], // Must have name before collecting email
  });
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
    "age", // Single field
    "interests", // Array field
    "preferences.notifications", // Nested field (dot notation)
    "preferences.theme", // Another nested field
  ],
  requires: ["name", "email"],
};
```

### Conditional Collection

```typescript
const conditionalCollection = {
  prompt: "Would you like to set up notifications? (yes/no)",
  collect: ["preferences.notifications"],
  skipIf: (data) => data.preferences?.notifications !== undefined,
  requires: ["name", "email"],
};
```

## Data Validation & Processing

### Lifecycle Hooks

```typescript
const validatedRoute = agent.createRoute({
  title: "Validated Collection",

  // Agent-level data validation
  hooks: {
    onDataUpdate: (newData, previousData) => {
      // Cross-field validation
      if (newData.email && newData.confirmEmail) {
        if (newData.email !== newData.confirmEmail) {
          throw new Error("Email addresses don't match");
        }
      }

      // Data enrichment
      if (newData.name && !newData.displayName) {
        newData.displayName = newData.name.split(" ")[0]; // First name only
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
