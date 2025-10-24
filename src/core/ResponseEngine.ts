import type {
  Event,
  StructuredSchema,
  SessionState,
  AgentOptions,
  Guideline,
  Term,
  Template,
} from "../types";
import type { Route } from "./Route";
import type { Step } from "./Step";
import { PromptComposer } from "./PromptComposer";
import { createTemplateContext, render } from "../utils/template";

export interface BuildResponsePromptParams<
  TContext = unknown,
  TData = unknown
> {
  route: Route<TContext, TData>;
  currentStep: Step<TContext, TData>;
  rules: Template<TContext, TData>[];
  prohibitions: Template<TContext, TData>[];
  directives: string[] | undefined;
  history: Event[];
  lastMessage: string;
  agentOptions?: AgentOptions<TContext, TData>;
  // Combined properties from agent and route
  combinedGuidelines?: Guideline<TContext, TData>[];
  combinedTerms?: Term<TContext, TData>[];
  context?: TContext;
  session?: SessionState<TData>;
  // NEW: Agent-level schema for data validation
  agentSchema?: StructuredSchema;
}

export interface BuildFallbackPromptParams<TContext = unknown, TData = unknown> {
  history: Event[];
  agentOptions: AgentOptions<TContext, TData>;
  terms: Term<TContext, TData>[];
  guidelines: Guideline<TContext, TData>[];
  context?: TContext;
  session?: SessionState<TData>;
}

export class ResponseEngine<TContext = unknown, TData = unknown> {
  responseSchemaForRoute(
    route: Route<TContext, TData>,
    currentStep?: Step<TContext, TData>,
    agentSchema?: StructuredSchema
  ): StructuredSchema {
    const base: StructuredSchema = {
      type: "object",
      properties: {
        message: { type: "string", description: "Final user-facing message" },
      },
      required: ["message"],
      additionalProperties: false,
    };

    // Add data field only if route has responseOutputSchema
    if (route.responseOutputSchema) {
      base.properties!.data = route.responseOutputSchema;
    }

    // Add collect fields from current step using agent-level schema
    if (currentStep?.collect && agentSchema?.properties) {
      for (const field of currentStep.collect) {
        const fieldSchema = agentSchema.properties[field as string];
        if (fieldSchema) {
          base.properties![field as string] = fieldSchema;
        }
      }
    }

    return base;
  }

  async buildResponsePrompt(
    params: BuildResponsePromptParams<TContext, TData>
  ): Promise<string> {
    const {
      route,
      currentStep,
      rules,
      prohibitions,
      directives,
      history,
      lastMessage,
      agentOptions,
      combinedGuidelines,
      combinedTerms,
      context,
      session,
      agentSchema,
    } = params;
    const templateContext = createTemplateContext({ context, session, history });
    const pc = new PromptComposer(templateContext);

    // Create combined agent options with route overrides
    let effectiveAgentOptions = agentOptions;
    if (agentOptions && (route.identity || route.personality)) {
      // Route identity and personality override agent versions
      effectiveAgentOptions = {
        ...agentOptions,
        ...(route.identity && { identity: route.identity }),
        ...(route.personality && { personality: route.personality }),
      };
    }

    if (effectiveAgentOptions) {
      await pc.addAgentMeta(effectiveAgentOptions);
    }
    await pc.addInstruction(
      `Route: ${route.title}${route.description ? ` — ${route.description}` : ""
      }`
    );
    if (currentStep.prompt) {
      await pc.addInstruction(
        `Guideline for your response (adapt to the conversation):\n${await render(
          currentStep.prompt,
          templateContext
        )}`
      );
    }
    if (rules.length)
      await pc.addInstruction(`Rules:\n- ${rules.join("\n- ")}`);
    if (prohibitions.length)
      await pc.addInstruction(`Prohibitions:\n- ${prohibitions.join("\n- ")}`);
    await pc.addDirectives(directives);
    await pc.addKnowledgeBase(
      agentOptions?.knowledgeBase,
      route.getKnowledgeBase()
    );

    // Add combined guidelines (agent + route)
    if (combinedGuidelines && combinedGuidelines.length > 0) {
      await pc.addGuidelines(combinedGuidelines);
    }

    // Add combined terms (agent + route)
    if (combinedTerms && combinedTerms.length > 0) {
      await pc.addGlossary(combinedTerms);
    }

    await pc.addInteractionHistory(history);
    await pc.addLastMessage(lastMessage);
    
    // Add data collection instructions - include ALL route fields, not just current step
    if (agentSchema?.properties) {
      // Collect all fields from route's required and optional fields
      const allRouteFields = new Set<string>();
      
      // Add route required fields
      if (route.requiredFields) {
        route.requiredFields.forEach(field => allRouteFields.add(String(field)));
      }
      
      // Add route optional fields
      if (route.optionalFields) {
        route.optionalFields.forEach(field => allRouteFields.add(String(field)));
      }
      
      // Add current step's collect fields (in case they're not in route fields)
      if (currentStep?.collect) {
        currentStep.collect.forEach(field => allRouteFields.add(String(field)));
      }
      
      if (allRouteFields.size > 0) {
        const stepCollectFields = new Set(currentStep?.collect?.map(f => String(f)) || []);
        const fieldDescriptions: string[] = [];
        
        for (const field of allRouteFields) {
          const fieldSchema = agentSchema.properties[field];
          if (fieldSchema) {
            const fieldName = field;
            const fieldDesc = fieldSchema.description || fieldName;
            const fieldType = Array.isArray(fieldSchema.type) ? fieldSchema.type[0] : fieldSchema.type;
            
            let fieldInfo = `  • ${fieldName} (${fieldType})`;
            
            // Add enum values if present
            if (fieldSchema.enum && Array.isArray(fieldSchema.enum)) {
              fieldInfo += ` [${fieldSchema.enum.join(' | ')}]`;
            }
            
            // Add description
            fieldInfo += `: ${fieldDesc}`;
            
            // Mark if this is the current step's focus
            if (stepCollectFields.has(field)) {
              fieldInfo += ` ← FOCUS FOR THIS STEP`;
            }
            
            fieldDescriptions.push(fieldInfo);
          }
        }
        
        if (fieldDescriptions.length > 0) {
          const instruction = [
            `## Data Collection Rules`,
            ``,
            `CRITICAL: You MUST extract ALL relevant information from the user's message, not just what this step asks for.`,
            ``,
            `Available fields to extract:`,
            ...fieldDescriptions,
            ``,
            `**How to collect data:**`,
            `1. Read the user's message carefully`,
            `2. Extract EVERY piece of information that matches ANY field above`,
            `3. Users often provide multiple details at once (e.g., "I need a checkup next Tuesday at 2 PM")`,
            `4. Include ALL extracted fields in your JSON response as top-level properties`,
            `5. Field names must match EXACTLY as shown above`,
            `6. Only include fields that the user actually mentioned`,
            ``,
            `**Example:** If user says "I need a checkup next Tuesday at 2 PM", extract:`,
            `- appointmentType: "checkup"`,
            `- preferredDate: "next Tuesday"`,
            `- preferredTime: "2 PM"`,
          ].join('\n');
          
          await pc.addInstruction(instruction);
        }
      }
    }
    
    // Add response format instructions with explicit JSON structure
    // Generate example JSON based on actual schema fields
    const exampleFields: string[] = ['  "message": "your response to the user"'];
    
    if (agentSchema?.properties) {
      // Collect all fields from route's required and optional fields
      const allRouteFields = new Set<string>();
      
      if (route.requiredFields) {
        route.requiredFields.forEach(field => allRouteFields.add(String(field)));
      }
      
      if (route.optionalFields) {
        route.optionalFields.forEach(field => allRouteFields.add(String(field)));
      }
      
      if (currentStep?.collect) {
        currentStep.collect.forEach(field => allRouteFields.add(String(field)));
      }
      
      // Generate example values for each field
      for (const field of allRouteFields) {
        const fieldSchema = agentSchema.properties[field];
        if (fieldSchema) {
          const fieldType = Array.isArray(fieldSchema.type) ? fieldSchema.type[0] : fieldSchema.type;
          let exampleValue = '"value if extracted"';
          
          // Generate type-appropriate example
          if (fieldSchema.enum && Array.isArray(fieldSchema.enum) && fieldSchema.enum.length > 0) {
            exampleValue = `"${fieldSchema.enum[0]}"`;
          } else if (fieldType === 'string') {
            exampleValue = '"extracted value"';
          } else if (fieldType === 'number' || fieldType === 'integer') {
            exampleValue = '0';
          } else if (fieldType === 'boolean') {
            exampleValue = 'true';
          }
          
          exampleFields.push(`  "${field}": ${exampleValue}`);
        }
      }
    }
    
    await pc.addInstruction(
      [
        `## Response Format`,
        ``,
        `You MUST return ONLY valid JSON in this exact format:`,
        `{`,
        ...exampleFields.map((f, i) => i < exampleFields.length - 1 ? `${f},` : f),
        `}`,
        ``,
        `CRITICAL RULES:`,
        `- Return ONLY the JSON object, no other text`,
        `- The "message" field is REQUIRED and must contain your response to the user`,
        `- Include ALL extracted data fields as top-level properties`,
        `- Only include data fields that were actually mentioned by the user`,
        `- Do not wrap the JSON in markdown code blocks`,
        `- Do not add any explanatory text before or after the JSON`,
      ].join('\n')
    );
    
    return pc.build();
  }

  async buildFallbackPrompt(
    params: BuildFallbackPromptParams<TContext, TData>
  ): Promise<string> {
    const { history, agentOptions, terms, guidelines, context, session } =
      params;
    const templateContext = createTemplateContext({ context, session, history });
    const pc = new PromptComposer(templateContext);

    await pc.addAgentMeta(agentOptions);
    await pc.addInteractionHistory(history);
    await pc.addGlossary(terms);
    await pc.addGuidelines(guidelines);
    await pc.addKnowledgeBase(agentOptions.knowledgeBase);
    return pc.build();
  }
}
