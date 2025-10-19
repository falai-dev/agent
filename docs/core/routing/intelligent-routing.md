# Intelligent Routing System

The AI routing system is the core intelligence layer of @falai/agent that enables dynamic, context-aware conversation flows. Unlike traditional state machines, the routing system uses AI to intelligently select routes and steps based on user intent, conversation history, and collected data.

## Overview

The `RoutingEngine` class powers two key decision-making processes:

1. **Route Selection**: When multiple routes are available, AI analyzes the conversation to score and select the most appropriate route
2. **Step Selection**: Within an active route, AI determines the best next step from available candidates

## How It Works

### Route Selection Process

When an agent has multiple routes defined, the routing engine:

1. **Analyzes Context**: Evaluates conversation history, user intent, and current session state
2. **Scores Routes**: Uses AI to score each route (0-100) based on relevance and semantic fit
3. **Applies Thresholds**: Considers switching costs and maintains conversation continuity
4. **Selects Winner**: Chooses the highest-scoring route or stays with the current route

### Step Selection Process

Within an active route, the routing engine:

1. **Finds Candidates**: Traverses the step chain to identify valid next steps
2. **Evaluates Conditions**: Respects `skipIf` conditions and `requires` dependencies
3. **AI Decision**: When multiple candidates exist, uses AI to select the optimal step
4. **Handles Completion**: Detects route completion and manages transitions

## Key Features

### Intelligent Route Scoring

Routes are scored based on multiple factors:

```typescript
// Routes receive scores 0-100 based on:
- Explicit keyword matches (90-100)
- Contextual evidence (70-89)
- Moderate relevance (50-69)
- Weak connections (30-49)
- Minimal relevance (0-29)
```

### Smart Step Traversal

The system intelligently traverses step chains:

- **Skip Logic**: Automatically skips steps where `skipIf` conditions are met
- **Dependency Checking**: Ensures required data is present before allowing step progression
- **Loop Prevention**: Uses visited sets to prevent infinite traversal
- **Branch Resolution**: Handles complex branching logic with AI assistance

### Context-Aware Decisions

All routing decisions consider:

- **Conversation History**: Full dialogue context
- **Collected Data**: What information has been gathered
- **Session State**: Current route and step position
- **Agent Knowledge**: Guidelines, terms, and domain knowledge

## Route Selection API

### Single Route Optimization

For agents with only one route, the system optimizes by skipping expensive route scoring:

```typescript
// Single route - direct step selection
const result = await routingEngine.decideSingleRouteStep({
  route: userOnboardingRoute,
  session,
  history,
  agentOptions,
  provider,
  context,
});
```

### Multi-Route Orchestration

For complex agents with multiple routes:

```typescript
// Multiple routes - full AI-powered selection
const result = await routingEngine.decideRouteAndStep({
  routes: [onboardingRoute, supportRoute, salesRoute],
  session,
  history,
  agentOptions,
  provider,
  context,
});
```

## Step Candidate Logic

### Finding Valid Steps

The `getCandidateSteps()` method implements sophisticated logic:

```typescript
// Find valid next steps considering:
const candidates = routingEngine.getCandidateSteps(
  route, // Current route
  currentStep, // Current step (or null for route start)
  collectedData // Session data collected so far
);
```

### SkipIf Processing

Steps are automatically filtered based on conditions:

```typescript
// Step definition with skipIf
initialStep: {
  prompt: "What's your name?",
  collect: ["name"],
  skipIf: (data) => data.name !== undefined  // Skip if name already collected
}
```

### Recursive Traversal

The system recursively traverses step chains to find valid paths:

```typescript
// Handles complex scenarios like:
// Step A (skipIf: condition) -> Step B -> Step C (requires: data)
// If Step A is skipped, system continues to Step B, then evaluates Step C
```

## Prompt Engineering

### Route Selection Prompts

The system builds comprehensive prompts for route selection:

```typescript
const routingPrompt = await routingEngine.buildRoutingPrompt({
  history,
  routes,
  lastMessage,
  agentOptions,
  session,
  activeRouteSteps,
  context,
});
```

Prompts include:

- Agent identity and personality
- Available routes with descriptions and conditions
- Session context and collected data
- Scoring guidelines (90-100 scale)
- Conversation history and directives

### Step Selection Prompts

For step selection within routes:

```typescript
const stepPrompt = await routingEngine.buildStepSelectionPrompt({
  route,
  currentStep,
  candidates,
  data: session.data,
  history,
  lastMessage,
  agentOptions,
  context,
  session,
});
```

## Response Processing

### Structured Scoring

AI responses use JSON schemas for reliable parsing:

```typescript
// Route scoring schema
{
  context: "Brief summary of user intent",
  routes: {
    "route-id-1": 85,  // Score 0-100
    "route-id-2": 72,
    "route-id-3": 45
  },
  responseDirectives: ["Focus on pricing", "Be helpful"]
}
```

### Step Selection Schema

```typescript
// Step selection schema
{
  reasoning: "Why this step was selected",
  selectedStepId: "step-id",
  responseDirectives: ["Address concerns", "Provide options"]
}
```

## Integration with Agent Flow

### Response Pipeline Integration

The routing engine integrates seamlessly with the response pipeline:

```typescript
// In Agent.respondStream():
1. Prepare context and session
2. Call routingEngine.decideRouteAndStep()
3. Execute prepare() functions on current step
4. Generate AI response with selected route/step
5. Process tool calls and data collection
6. Handle route completion and transitions
```

### Session State Management

Routing decisions update session state:

```typescript
// Session updates include:
- Current route transitions
- Step progression
- Initial data merging
- Route completion handling
- Pending transition management
```

## Performance Optimizations

### Single Route Fast Path

For agents with one route, skips route scoring entirely:

```typescript
if (routes.length === 1) {
  return this.decideSingleRouteStep(/* optimized path */);
}
```

### Candidate Limiting

Applies configurable limits to prevent excessive AI calls:

```typescript
const limited = maxCandidates ? entries.slice(0, maxCandidates) : entries;
```

## Error Handling & Resilience

### Backup Model Support

When primary AI models fail, automatically tries backup models:

```typescript
// Automatic fallback to backup models
// Error classification (rate limits, overloads, etc.)
// Timeout and retry logic
```

### Validation & Fallbacks

Robust validation ensures system stability:

```typescript
// Invalid responses fallback to first candidate
// Missing data handled gracefully
// Circular dependencies prevented
```

## Configuration Options

### Routing Engine Options

```typescript
const routingEngine = new RoutingEngine({
  allowRouteSwitch: true, // Allow switching between routes
  switchThreshold: 70, // Minimum score to switch routes
  maxCandidates: 5, // Limit AI evaluation candidates
});
```

## Best Practices

### Route Design

1. **Clear Conditions**: Define specific conditions for route activation
2. **Distinct Purposes**: Ensure routes serve different user intents
3. **Progressive Disclosure**: Use step dependencies to control information flow
4. **Completion Handling**: Define clear end states and transitions

### Step Design

1. **Atomic Actions**: Each step should accomplish one clear goal
2. **Smart Skipping**: Use `skipIf` to avoid redundant questions
3. **Data Dependencies**: Use `requires` to enforce logical flow
4. **Branch Wisely**: AI can handle branching but prefer linear flows when possible

### Performance

1. **Limit Routes**: Too many routes increase AI evaluation time
2. **Optimize Prompts**: Keep route/step descriptions concise
3. **Cache Context**: Reuse context when possible
4. **Monitor Scores**: Track route selection accuracy and adjust conditions

## Debugging & Monitoring

### Route Selection Logging

```typescript
// Debug logging shows:
- Route scores and reasoning
- Selected routes and steps
- Candidate evaluation process
- Context analysis results
```

### Performance Metrics

```typescript
// Track:
- Route selection accuracy
- Step transition success rates
- AI call latency and costs
- User satisfaction scores
```

The intelligent routing system transforms traditional conversation design from static flows into dynamic, AI-driven experiences that adapt to user needs and context.
