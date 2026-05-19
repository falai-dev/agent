import type {
  Event,
  StructuredSchema,
  SessionState,
  AgentOptions,
  Term,
  Template,
  ScopedInstructions,
  AppliedInstruction,
} from "../types";
import type { Flow } from "./Flow";
import type { Step } from "./Step";
import { PromptComposer } from "./PromptComposer";
import { PromptSectionCache } from "./PromptSectionCache";
import { createTemplateContext, render } from "../utils/template";

export interface BuildResponsePromptParams<
  TContext = unknown,
  TData = unknown
> {
  flow: Flow<TContext, TData>;
  currentStep: Step<TContext, TData>;
  rules: Template<TContext, TData>[];
  prohibitions: Template<TContext, TData>[];
  directives: string[] | undefined;
  history: Event[];
  agentOptions?: AgentOptions<TContext, TData>;
  // Scoped instructions (agent, flow, step)
  instructions?: ScopedInstructions<TContext, TData>;
  combinedTerms?: Term<TContext, TData>[];
  context?: TContext;
  session?: SessionState<TData>;
  // NEW: Agent-level schema for data validation
  agentSchema?: StructuredSchema;
  /**
   * Per-turn transient appendage from merged Directive.appendPrompt arrays.
   * Appended to the system prompt after all other sections.
   * Fresh every turn, never cached, never persisted.
   */
  transientAppendage?: string[];
}

export interface BuildFallbackPromptParams<TContext = unknown, TData = unknown> {
  agentOptions: AgentOptions<TContext, TData>;
  terms: Term<TContext, TData>[];
  instructions?: ScopedInstructions<TContext, TData>;
  context?: TContext;
  session?: SessionState<TData>;
}

export interface PromptBuilderResult {
  prompt: string;
  appliedInstructions: AppliedInstruction[];
}

export class ResponseEngine<TContext = unknown, TData = unknown> {
  constructor(private readonly promptSectionCache?: PromptSectionCache) { }

  responseSchemaForFlow(
    flow: Flow<TContext, TData>,
    currentStep?: Step<TContext, TData>,
    agentSchema?: StructuredSchema
  ): StructuredSchema {
    const base: StructuredSchema = {
      type: "object",
      properties: {
        message: { type: "string", description: "Natural, conversational response directed at the user. Must NOT contain field names, raw data, or internal information." },
      },
      required: ["message"],
      additionalProperties: false,
    };

    // Add data field only if flow has responseOutputSchema
    if (flow.responseOutputSchema) {
      base.properties!.data = flow.responseOutputSchema;
    }

    // Add collect fields from current step
    if (currentStep?.collect) {
      if (agentSchema?.properties) {
        // Use agent schema definitions for collect fields
        for (const field of currentStep.collect) {
          const fieldSchema = agentSchema.properties[field as string];
          if (fieldSchema) {
            base.properties![field as string] = fieldSchema;
          }
        }
      } else {
        // No agent schema - generate dynamic schema from collect fields
        for (const field of currentStep.collect) {
          base.properties![field as string] = {
            type: "string",
            description: `Collected value for ${String(field)}`,
          };
        }
      }
    }

    return base;
  }

  async buildResponsePrompt(
    params: BuildResponsePromptParams<TContext, TData>
  ): Promise<PromptBuilderResult> {
    const {
      flow,
      currentStep,
      rules,
      prohibitions,
      directives,
      history,
      agentOptions,
      instructions,
      combinedTerms,
      context,
      session,
      agentSchema,
      transientAppendage,
    } = params;
    const templateContext = createTemplateContext({ context, session, history });
    const pc = new PromptComposer(templateContext, this.promptSectionCache);

    // Create combined agent options — flow no longer overrides persona
    const effectiveAgentOptions = agentOptions;

    if (effectiveAgentOptions) {
      await pc.addAgentMeta(effectiveAgentOptions);
    }
    await pc.addInstruction(
      `Flow: ${flow.title}${flow.description ? ` — ${flow.description}` : ""
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
      flow.knowledgeBase
    );

    // Add scoped instructions (agent + flow + step)
    if (instructions) {
      await pc.addInstructions(instructions);
    }

    // Add combined terms (agent + flow)
    if (combinedTerms && combinedTerms.length > 0) {
      await pc.addGlossary(combinedTerms);
    }

    // Add data collection instructions - include ALL flow fields, not just current step
    // Collect all fields from flow's required and optional fields
    const allFlowFields = new Set<string>();

    if (flow.requiredFields) {
      flow.requiredFields.forEach(field => allFlowFields.add(String(field)));
    }
    if (flow.optionalFields) {
      flow.optionalFields.forEach(field => allFlowFields.add(String(field)));
    }
    if (currentStep?.collect) {
      currentStep.collect.forEach(field => allFlowFields.add(String(field)));
    }

    if (allFlowFields.size > 0) {
      const stepCollectFields = new Set(currentStep?.collect?.map(f => String(f)) || []);
      const fieldDescriptions: string[] = [];

      for (const field of allFlowFields) {
        if (agentSchema?.properties) {
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
        } else {
          // No agent schema - generate dynamic description from field name
          let fieldInfo = `  • ${field} (string): ${field}`;
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

    // Add response format instructions with explicit JSON structure
    // Generate example JSON based on actual schema fields
    const exampleFields: string[] = ['  "message": "your response to the user"'];

    for (const field of allFlowFields) {
      if (agentSchema?.properties) {
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
      } else {
        // No agent schema - use string as default
        exampleFields.push(`  "${field}": "extracted value"`);
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
        `- The "message" field is REQUIRED and must contain a natural, conversational response directed at the user`,
        `- The "message" MUST read like a human conversation - warm, natural, and contextual`,
        `- NEVER include field names, JSON keys, schema properties, raw data values, or technical/internal information in the "message"`,
        `- NEVER echo back data in the format "fieldName: value" in the "message" - data goes in the JSON fields, not the message`,
        `- Include ALL extracted data fields as separate top-level JSON properties (NOT inside the message text)`,
        `- Only include data fields that were actually mentioned by the user`,
        `- Do not wrap the JSON in markdown code blocks`,
        `- Do not add any explanatory text before or after the JSON`,
      ].join('\n')
    );

    const prompt = await pc.build({ transientAppendage });
    return {
      prompt,
      appliedInstructions: pc.lastAppliedInstructions ?? [],
    };
  }

  async buildFallbackPrompt(
    params: BuildFallbackPromptParams<TContext, TData>
  ): Promise<PromptBuilderResult> {
    const { agentOptions, terms, instructions, context, session } =
      params;
    const templateContext = createTemplateContext({ context, session });
    const pc = new PromptComposer(templateContext, this.promptSectionCache);

    await pc.addAgentMeta(agentOptions);
    await pc.addGlossary(terms);
    if (instructions) {
      await pc.addInstructions(instructions);
    }
    await pc.addKnowledgeBase(agentOptions.knowledgeBase);
    const prompt = await pc.build();
    return {
      prompt,
      appliedInstructions: pc.lastAppliedInstructions ?? [],
    };
  }
}
