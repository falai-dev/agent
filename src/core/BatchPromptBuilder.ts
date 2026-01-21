/**
 * BatchPromptBuilder - Combines multiple Step prompts into a single coherent prompt
 * 
 * Responsible for building a combined prompt for batch execution of multiple Steps
 * in a single LLM call.
 * 
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
 */

import type { StepOptions } from '../types/route';
import type { AgentOptions } from '../types/agent';
import type { SessionState } from '../types/session';
import type { Event } from '../types/history';
import type { Route } from './Route';
import { render, createTemplateContext } from '../utils/template';
import { PromptComposer } from './PromptComposer';

/**
 * Parameters for building a batch prompt
 */
export interface BuildBatchPromptParams<TContext, TData> {
  /** Steps included in this batch */
  steps: StepOptions<TContext, TData>[];
  /** The route containing the steps */
  route: Route<TContext, TData>;
  /** Conversation history */
  history: Event[];
  /** Agent context */
  context: TContext;
  /** Current session state */
  session: SessionState<TData>;
  /** Agent options for identity/personality */
  agentOptions: AgentOptions<TContext, TData>;
}

/**
 * Result of building a batch prompt
 */
export interface BatchPromptResult {
  /** The combined prompt string */
  prompt: string;
  /** All collect fields from all steps in the batch */
  collectFields: string[];
  /** Number of steps included in the prompt */
  stepCount: number;
}

/**
 * BatchPromptBuilder class - builds combined prompts for batch execution
 * 
 * Combines multiple Step prompts into a single coherent prompt that:
 * - Preserves the intent of each Step's individual prompt
 * - Includes data collection instructions for all collect fields
 * - Produces a single LLM call regardless of the number of Steps
 * 
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
 */
export class BatchPromptBuilder<TContext = unknown, TData = unknown> {
  /**
   * Build a combined prompt for a batch of Steps
   * 
   * @param params - Parameters for building the batch prompt
   * @returns BatchPromptResult with the combined prompt and metadata
   * 
   * **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
   */
  async buildBatchPrompt(params: BuildBatchPromptParams<TContext, TData>): Promise<BatchPromptResult> {
    const { steps, route, history, context, session, agentOptions } = params;
    
    // Create template context for rendering
    const templateContext = createTemplateContext<TContext, TData>({
      context,
      data: session.data,
      session,
      history,
    });
    
    // Collect all collect fields from all steps
    const collectFields: string[] = [];
    for (const step of steps) {
      if (step.collect && step.collect.length > 0) {
        for (const field of step.collect) {
          const fieldStr = String(field);
          if (!collectFields.includes(fieldStr)) {
            collectFields.push(fieldStr);
          }
        }
      }
    }
    
    // Build the combined prompt using PromptComposer for consistency
    const composer = new PromptComposer<TContext, TData>(templateContext);
    
    // Add agent meta information
    await composer.addAgentMeta(agentOptions);
    
    // Add route-specific identity/personality if available
    if (route.identity) {
      const identity = await render(route.identity, templateContext);
      if (identity) {
        await composer.addInstruction(`**Route Identity:** ${identity}`);
      }
    }
    
    if (route.personality) {
      const personality = await render(route.personality, templateContext);
      if (personality) {
        await composer.addInstruction(`**Route Personality:** ${personality}`);
      }
    }
    
    // Add knowledge base if available
    await composer.addKnowledgeBase(agentOptions.knowledgeBase, route.getKnowledgeBase());
    
    // Add glossary terms
    const allTerms = [...(agentOptions.terms || []), ...route.getTerms()];
    await composer.addGlossary(allTerms);
    
    // Add guidelines
    const allGuidelines = [...(agentOptions.guidelines || []), ...route.getGuidelines()];
    await composer.addGuidelines(allGuidelines);
    
    // Add interaction history
    await composer.addInteractionHistory(history, 'Recent conversation context:');
    
    // Build the step sections
    const stepSections = await this.buildStepSections(steps, templateContext);
    
    // Add the conversation flow section
    if (steps.length > 1) {
      await composer.addInstruction(
        `## Current Conversation Flow\n\n` +
        `You are handling multiple aspects of this conversation in a single response.\n\n` +
        stepSections
      );
    } else if (steps.length === 1) {
      await composer.addInstruction(
        `## Current Step\n\n` +
        stepSections
      );
    }
    
    // Add data collection section if there are fields to collect
    if (collectFields.length > 0) {
      const collectionSection = this.buildDataCollectionSection(collectFields, agentOptions);
      await composer.addInstruction(collectionSection);
    }
    
    // Add response format instructions
    const responseFormat = this.buildResponseFormatSection(collectFields);
    await composer.addInstruction(responseFormat);
    
    // Build the final prompt
    const prompt = await composer.build();
    
    return {
      prompt,
      collectFields,
      stepCount: steps.length,
    };
  }
  
  /**
   * Build the step sections of the prompt
   * 
   * @param steps - Steps to include in the prompt
   * @param templateContext - Template context for rendering
   * @returns Formatted step sections string
   */
  private async buildStepSections(
    steps: StepOptions<TContext, TData>[],
    templateContext: ReturnType<typeof createTemplateContext<TContext, TData>>
  ): Promise<string> {
    const sections: string[] = [];
    
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepNumber = i + 1;
      
      // Build step header
      const description = step.description || `Step ${stepNumber}`;
      let section = `### Step ${stepNumber}: ${description}\n`;
      
      // Render and add step prompt if available
      if (step.prompt) {
        const renderedPrompt = await render(step.prompt, templateContext);
        if (renderedPrompt) {
          section += `\n${renderedPrompt}\n`;
        }
      }
      
      // Add collect fields for this step if any
      if (step.collect && step.collect.length > 0) {
        const collectList = step.collect.map(f => `\`${String(f)}\``).join(', ');
        section += `\n**Collect:** ${collectList}\n`;
      }
      
      sections.push(section);
    }
    
    return sections.join('\n');
  }
  
  /**
   * Build the data collection section of the prompt
   * 
   * @param collectFields - Fields to collect from the response
   * @param agentOptions - Agent options containing schema information
   * @returns Formatted data collection section string
   */
  private buildDataCollectionSection(
    collectFields: string[],
    agentOptions: AgentOptions<TContext, TData>
  ): string {
    const lines: string[] = [
      '## Data Collection',
      '',
      'Extract the following information from your response:',
      ''
    ];
    
    // Get schema information if available
    const schema = agentOptions.schema;
    
    for (const field of collectFields) {
      let fieldDescription = field;
      
      // Try to get field type/description from schema
      if (schema?.properties && schema.properties[field]) {
        const fieldSchema = schema.properties[field] as Record<string, unknown>;
        const type = fieldSchema.type || 'string';
        const description = fieldSchema.description || '';
        
        if (description) {
          fieldDescription = `${field} (${type}): ${description}`;
        } else {
          fieldDescription = `${field} (${type})`;
        }
      }
      
      lines.push(`- ${fieldDescription}`);
    }
    
    return lines.join('\n');
  }
  
  /**
   * Build the response format section of the prompt
   * 
   * @param collectFields - Fields to collect from the response
   * @returns Formatted response format section string
   */
  private buildResponseFormatSection(collectFields: string[]): string {
    const lines: string[] = [
      '## Response Format',
      '',
      'Return JSON with:',
      '- `message`: Your response to the user'
    ];
    
    if (collectFields.length > 0) {
      lines.push('');
      lines.push('Include the following collected fields as top-level properties:');
      for (const field of collectFields) {
        lines.push(`- \`${field}\``);
      }
    }
    
    return lines.join('\n');
  }
}
