/**
 * Prompt construction and management
 */

import type { Event, EmittedEvent, MessageEventData } from "../types/history";
import { EventKind, EventSource } from "../types/history";
import type { Term, Capability, GuidelineMatch } from "../types/agent";
import type { PromptSection, ContextVariableValue } from "../types/prompt";
import { SectionStatus } from "../types/prompt";

import { adaptEvent } from "./Events";

/**
 * Built-in section identifiers
 */
export enum BuiltInSection {
  AGENT_IDENTITY = "agent_identity",
  CUSTOMER_IDENTITY = "customer_identity",
  INTERACTION_HISTORY = "interaction_history",
  CONTEXT_VARIABLES = "context_variables",
  GLOSSARY = "glossary",
  GUIDELINE_DESCRIPTIONS = "guideline_descriptions",
  GUIDELINES = "guidelines",
  STAGED_EVENTS = "staged_events",
  ROUTES = "routes",
  OBSERVATIONS = "observations",
  CAPABILITIES = "capabilities",
  ACTIVE_ROUTES = "active_routes",
  DOMAINS = "domains",
}

/**
 * Customer/user information
 */
export interface Customer {
  name: string;
  id?: string;
}

/**
 * Agent information for prompt building
 */
export interface AgentInfo {
  name: string;
  description?: string;
}

/**
 * Builds prompts from composable sections
 */
export class PromptBuilder {
  private sections: Map<string | BuiltInSection, PromptSection> = new Map();
  private onBuild?: (prompt: string) => void;
  private cachedResults = new Set<string>();

  constructor(onBuild?: (prompt: string) => void) {
    this.onBuild = onBuild;
  }

  /**
   * Build the final prompt from all sections
   */
  build(): string {
    const parts: string[] = [];

    for (const section of this.sections.values()) {
      try {
        const formatted = this.formatTemplate(section.template, section.props);
        parts.push(formatted);
      } catch (error) {
        throw new Error(
          `Error formatting section: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
    }

    const prompt = parts.join("\n\n").trim();

    if (this.onBuild && !this.cachedResults.has(prompt)) {
      this.onBuild(prompt);
      this.cachedResults.add(prompt);
    }

    return prompt;
  }

  /**
   * Add a section to the prompt
   */
  addSection(
    name: string | BuiltInSection,
    template: string,
    props: Record<string, unknown> = {},
    status?: SectionStatus
  ): this {
    if (this.sections.has(name)) {
      throw new Error(`Section '${String(name)}' already exists`);
    }

    this.sections.set(name, {
      template,
      props,
      status,
    });

    return this;
  }

  /**
   * Edit an existing section
   */
  editSection(
    name: string | BuiltInSection,
    editor: (section: PromptSection) => PromptSection
  ): this {
    const section = this.sections.get(name);
    if (section) {
      this.sections.set(name, editor(section));
    }
    return this;
  }

  /**
   * Get section status
   */
  sectionStatus(name: string | BuiltInSection): SectionStatus {
    const section = this.sections.get(name);
    return section?.status || SectionStatus.NONE;
  }

  /**
   * Add agent identity section
   */
  addAgentIdentity(agent: AgentInfo): this {
    if (agent.description) {
      this.addSection(
        BuiltInSection.AGENT_IDENTITY,
        `You are an AI agent named {agent_name}.

The following is a description of your background and personality: ###
{agent_description}
###`,
        {
          agent_name: agent.name,
          agent_description: agent.description,
        },
        SectionStatus.ACTIVE
      );
    }
    return this;
  }

  /**
   * Add customer identity section
   */
  addCustomerIdentity(customer: Customer): this {
    this.addSection(
      BuiltInSection.CUSTOMER_IDENTITY,
      `The user you're interacting with is called {customer_name}.`,
      { customer_name: customer.name },
      SectionStatus.ACTIVE
    );
    return this;
  }

  /**
   * Add interaction history section
   */
  addInteractionHistory(
    events: Event[],
    stagedEvents: EmittedEvent[] = []
  ): this {
    if (events.length === 0 && stagedEvents.length === 0) {
      this.addSection(
        BuiltInSection.INTERACTION_HISTORY,
        `Your interaction with the user has just began, and no events have been recorded yet.
Proceed with your task accordingly.`,
        {},
        SectionStatus.PASSIVE
      );
    } else {
      const interactionEvents = this.gatherInteractionEvents(
        events,
        stagedEvents
      );
      this.addSection(
        BuiltInSection.INTERACTION_HISTORY,
        `The following is a list of events describing a back-and-forth
interaction between you and a user: ###
{interaction_events}
###`,
        { interaction_events: interactionEvents.join("\n") },
        SectionStatus.ACTIVE
      );
    }
    return this;
  }

  /**
   * Add interaction history with special handling for message generation
   */
  addInteractionHistoryForMessageGeneration(
    events: Event[],
    stagedEvents: EmittedEvent[] = []
  ): this {
    if (events.length === 0 && stagedEvents.length === 0) {
      return this.addInteractionHistory(events, stagedEvents);
    }

    const interactionEvents = this.gatherInteractionEvents(
      events,
      stagedEvents
    );
    const lastEventNote = this.lastAgentMessageNote(events);

    let template = `The following is a list of events describing a back-and-forth
interaction between you and a user: ###
{interaction_events}
###`;

    const props: Record<string, unknown> = {
      interaction_events: interactionEvents.join("\n"),
    };

    if (lastEventNote) {
      template += "\n\n{last_event_note}";
      props.last_event_note = lastEventNote;
    }

    this.addSection(
      BuiltInSection.INTERACTION_HISTORY,
      template,
      props,
      SectionStatus.ACTIVE
    );

    return this;
  }

  /**
   * Add context variables section
   */
  addContextVariables(variables: ContextVariableValue[]): this {
    if (variables.length > 0) {
      const contextValues = this.contextVariablesToJson(variables);
      this.addSection(
        BuiltInSection.CONTEXT_VARIABLES,
        `The following is information that you're given about the user and context of the interaction: ###
{context_values}
###`,
        { context_values: contextValues },
        SectionStatus.ACTIVE
      );
    }
    return this;
  }

  /**
   * Add glossary section
   */
  addGlossary(terms: Term[]): this {
    if (terms.length > 0) {
      const termsString = terms
        .map((t, i) => {
          const synonyms = t.synonyms?.length
            ? ` (synonyms: ${t.synonyms.join(", ")})`
            : "";
          return `${i + 1}) ${t.name}${synonyms}: ${t.description}`;
        })
        .join("\n");

      this.addSection(
        BuiltInSection.GLOSSARY,
        `The following is a glossary of the business.
Understanding these terms, as they apply to the business, is critical for your task.
When encountering any of these terms, prioritize the interpretation provided here over any definitions you may already know.
Please be tolerant of possible typos by the user with regards to these terms,
and let the user know if/when you assume they meant a term by their typo: ###
{terms_string}
###`,
        { terms_string: termsString },
        SectionStatus.ACTIVE
      );
    }
    return this;
  }

  /**
   * Add staged tool events section
   */
  addStagedToolEvents(events: EmittedEvent[]): this {
    const toolEvents = events.filter((e) => e.kind === EventKind.TOOL);

    if (toolEvents.length > 0) {
      const stagedEventsAsDict = toolEvents.map((e) => adaptEvent(e));

      this.addSection(
        BuiltInSection.STAGED_EVENTS,
        `Here are the most recent staged events for your reference.
They represent interactions with external tools that perform actions or provide information.
Prioritize their data over any other sources and use their details to complete your task: ###
{staged_events_as_dict}
###`,
        { staged_events_as_dict: stagedEventsAsDict.join("\n") },
        SectionStatus.ACTIVE
      );
    }
    return this;
  }

  /**
   * Add guidelines for message generation
   */
  addGuidelinesForMessageGeneration(guidelines: GuidelineMatch[]): this {
    if (guidelines.length === 0) {
      this.addSection(
        BuiltInSection.GUIDELINE_DESCRIPTIONS,
        `In formulating your reply, you are normally required to follow a number of behavioral guidelines.
However, in this case, no special behavioral guidelines were provided. Therefore, when generating revisions,
you don't need to specifically double-check if you followed or broke any guidelines.`,
        {},
        SectionStatus.PASSIVE
      );
      return this;
    }

    const guidelineList = guidelines
      .map((g, i) => {
        const num = i + 1;
        let text = g.guideline.condition
          ? `Guideline #${num}) When ${g.guideline.condition}, then ${g.guideline.action}`
          : `Guideline #${num}) ${g.guideline.action}`;

        if (g.rationale) {
          text += `\n      - Rationale: ${g.rationale}`;
        }

        return text;
      })
      .join("\n");

    this.addSection(
      BuiltInSection.GUIDELINE_DESCRIPTIONS,
      `When crafting your reply, you must follow the behavioral guidelines provided below, which have been identified as relevant to the current state of the interaction.

- **Guidelines**:
{guideline_list}

You may choose not to follow a guideline only in the following cases:
    - It conflicts with a previous customer request.
    - It is clearly inappropriate given the current context of the conversation.
    - It lacks sufficient context or data to apply reliably.
    - It conflicts with an insight.

In all other situations, you are expected to adhere to the guidelines.
These guidelines have already been pre-filtered based on the interaction's context and other considerations outside your scope.`,
      { guideline_list: guidelineList },
      SectionStatus.ACTIVE
    );

    return this;
  }

  /**
   * Add capabilities section for message generation
   */
  addCapabilitiesForMessageGeneration(capabilities: Capability[]): this {
    if (capabilities.length > 0) {
      const capabilitiesString = capabilities
        .map(
          (c, i) => `Supported Capability ${i + 1}: ${c.title}
${c.description}`
        )
        .join("\n\n");

      this.addSection(
        BuiltInSection.CAPABILITIES,
        `Below are the capabilities available to you as an agent.
You may inform the customer that you can assist them using these capabilities.
If you choose to use any of them, additional details will be provided in your next response.
Always prefer adhering to guidelines, before offering capabilities - only offer capabilities if you have no other instruction that's relevant for the current stage of the interaction.
Be proactive and offer the most relevant capabilities—but only if they are likely to move the conversation forward.
If multiple capabilities are appropriate, aim to present them all to the customer.
If none of the capabilities address the current request of the customer - DO NOT MENTION THEM.
###
{capabilities_string}
###`,
        { capabilities_string: capabilitiesString },
        SectionStatus.ACTIVE
      );
    }
    return this;
  }

  /**
   * Add observations for disambiguation
   */
  addObservations(
    observations: Array<{
      description: string;
      routes: Array<{ title: string }>;
    }>
  ): this {
    if (observations.length > 0) {
      const observationsString = observations
        .map((obs, i) => {
          const routeTitles = obs.routes.map((r) => `"${r.title}"`).join(", ");
          return `${i + 1}) "${
            obs.description
          }" → Can lead to routes: ${routeTitles}`;
        })
        .join("\n");

      this.addSection(
        BuiltInSection.OBSERVATIONS,
        `The following observations may help you understand the user's intent and choose the appropriate response path:
###
{observations_string}
###

When you detect any of these situations, consider which route would be most appropriate based on the user's actual need.`,
        { observations_string: observationsString },
        SectionStatus.ACTIVE
      );
    }
    return this;
  }

  /**
   * Add active routes information
   */
  addActiveRoutes(
    routes: Array<{
      title: string;
      description?: string;
      conditions: string[];
      domains?: string[];
      rules?: string[];
      prohibitions?: string[];
    }>
  ): this {
    if (routes.length > 0) {
      const routesString = routes
        .map((route, i) => {
          const conditions =
            route.conditions.length > 0
              ? `\n  Triggered when: ${route.conditions.join(" OR ")}`
              : "";
          const desc = route.description ? `\n  ${route.description}` : "";
          
          let domainInfo = "";
          if (route.domains !== undefined) {
            if (route.domains.length === 0) {
              domainInfo = "\n  Available tools: None (conversation only)";
            } else {
              domainInfo = `\n  Available tools: ${route.domains.join(", ")}`;
            }
          }

          let rulesInfo = "";
          if (route.rules && route.rules.length > 0) {
            const rulesList = route.rules.map((r, idx) => `${idx + 1}. ${r}`).join("; ");
            rulesInfo = `\n  RULES: ${rulesList}`;
          }

          let prohibitionsInfo = "";
          if (route.prohibitions && route.prohibitions.length > 0) {
            const prohibitionsList = route.prohibitions.map((p, idx) => `${idx + 1}. ${p}`).join("; ");
            prohibitionsInfo = `\n  PROHIBITIONS: ${prohibitionsList}`;
          }

          return `${i + 1}) ${route.title}${desc}${conditions}${domainInfo}${rulesInfo}${prohibitionsInfo}`;
        })
        .join("\n\n");

      this.addSection(
        BuiltInSection.ACTIVE_ROUTES,
        `Available conversation routes:
###
{routes_string}
###

These routes represent different paths the conversation can take. Choose the most appropriate route based on the user's needs.
IMPORTANT: 
- If a route specifies available tools, you can ONLY call tools from those domains when following that route.
- If a route has RULES, you MUST follow them when you choose that route.
- If a route has PROHIBITIONS, you MUST NEVER do those things when you choose that route.`,
        { routes_string: routesString },
        SectionStatus.ACTIVE
      );
    }
    return this;
  }

  /**
   * Add domains (tools) information
   */
  addDomains(
    domains: Record<string, Record<string, unknown>>
  ): this {
    const domainNames = Object.keys(domains);
    if (domainNames.length > 0) {
      const domainsString = domainNames
        .map((name, i) => {
          const toolNames = Object.keys(domains[name]);
          const tools = toolNames.join(", ");
          return `${i + 1}) Domain "${name}": ${tools}`;
        })
        .join("\n");

      this.addSection(
        BuiltInSection.DOMAINS,
        `Available tool domains:
###
{domains_string}
###

These are the tool domains registered in the system. Each domain contains specific tools/methods.
When calling tools, use the format: domain.toolName (e.g., "payment.processPayment").`,
        { domains_string: domainsString },
        SectionStatus.ACTIVE
      );
    }
    return this;
  }


  /**
   * Add JSON response schema instructions
   */
  addJsonResponseSchema(): this {
    const schema = {
      message: "The actual message to send to the user",
      route: "The title of the route you chose (or null if no specific route)",
      state: "The current state within the route (or null if not in a route)",
      toolCalls: [
        {
          toolName: "Name of the tool to call",
          arguments: "Object with tool arguments",
        },
      ],
      reasoning: "Optional: Your internal reasoning for this response",
    };

    this.addSection(
      "json_response_format",
      `IMPORTANT: You must respond with valid JSON in the following format:

\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\`

Instructions:
- "message": The actual message to send to the user (required)
- "route": If you chose a specific conversation route, provide its exact title. If not in a route, use null.
- "state": The current state within the chosen route. If not in a route or at initial state, use null.
- "toolCalls": If you need to call any tools, provide an array of tool calls. If no tools needed, use an empty array or omit.
- "reasoning": Optional field for your internal thinking process.

Your entire response must be valid JSON. Do not include any text before or after the JSON object.`,
      {},
      SectionStatus.ACTIVE
    );
    return this;
  }

  // Helper methods

  private formatTemplate(
    template: string,
    props: Record<string, unknown>
  ): string {
    return template.replace(/\{(\w+)\}/g, (match, key: string) => {
      if (key in props) {
        return String(props[key]);
      }
      return match;
    });
  }

  private gatherInteractionEvents(
    events: Event[],
    stagedEvents: EmittedEvent[]
  ): string[] {
    const combined = [...events, ...stagedEvents];
    return combined
      .filter((e) => e.kind !== EventKind.STATUS)
      .map((e) => adaptEvent(e));
  }

  private lastAgentMessageNote(events: Event[]): string | null {
    const lastMessageEvent = [...events]
      .reverse()
      .find((e) => e.kind === EventKind.MESSAGE);

    if (!lastMessageEvent || lastMessageEvent.source !== EventSource.AI_AGENT) {
      return null;
    }

    const lastMessage = (lastMessageEvent.data as MessageEventData).message;
    return `IMPORTANT: Please note that the last message was sent by you, the AI agent (likely as a preamble). Your last message was: ###
${lastMessage}
###

You must keep that in mind when responding to the user, to continue the last message naturally (without repeating anything similar in your last message - make sure you don't repeat something like this in your next message - it was already said!).`;
  }

  private contextVariablesToJson(variables: ContextVariableValue[]): string {
    const obj: Record<string, unknown> = {};
    for (const v of variables) {
      obj[v.variable.name] = v.value;
    }
    return JSON.stringify(obj, null, 2);
  }
}
