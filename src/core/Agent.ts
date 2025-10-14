/**
 * Core Agent implementation
 */

import type {
  AgentOptions,
  Term,
  Guideline,
  GuidelineMatch,
  Capability,
} from "../types/agent";
import type { Event, StateRef } from "../types/index";
import type { RouteOptions } from "../types/route";

import { Route } from "./Route";
import { DomainRegistry } from "./DomainRegistry";
import { PromptBuilder } from "./PromptBuilder";
import { Observation } from "./Observation";

/**
 * Main Agent class with generic context support
 */
export class Agent<TContext = unknown> {
  private terms: Term[] = [];
  private guidelines: Guideline[] = [];
  private capabilities: Capability[] = [];
  private routes: Route<TContext>[] = [];
  private observations: Observation[] = [];
  private domainRegistry = new DomainRegistry();
  private context: TContext | undefined;

  /**
   * Dynamic domain property - populated via addDomain
   */
  public readonly domain: Record<string, Record<string, unknown>> = {};

  constructor(private readonly options: AgentOptions<TContext>) {
    // Initialize with default values
    if (!this.options.maxEngineIterations) {
      this.options.maxEngineIterations = 1;
    }

    // Validate context configuration
    if (options.context !== undefined && options.contextProvider) {
      throw new Error(
        "Cannot provide both 'context' and 'contextProvider'. Choose one."
      );
    }

    // Initialize context if provided
    this.context = options.context;

    // Initialize from options
    if (options.terms) {
      this.terms = [...options.terms];
    }

    if (options.guidelines) {
      options.guidelines.forEach((guideline) => {
        this.createGuideline(guideline);
      });
    }

    if (options.capabilities) {
      options.capabilities.forEach((capability) => {
        this.createCapability(capability);
      });
    }

    if (options.routes) {
      options.routes.forEach((routeOptions) => {
        this.createRoute(routeOptions);
      });
    }

    if (options.observations) {
      options.observations.forEach((obsOptions) => {
        const obs = this.createObservation(obsOptions.description);

        // If route refs were provided, resolve and disambiguate
        if (obsOptions.routeRefs && obsOptions.routeRefs.length > 0) {
          const resolvedRoutes = obsOptions.routeRefs
            .map((ref) => {
              // Try to find route by ID or title
              return this.routes.find((r) => r.id === ref || r.title === ref);
            })
            .filter((r): r is Route<TContext> => r !== undefined);

          if (resolvedRoutes.length > 0) {
            obs.disambiguate(resolvedRoutes);
          }
        }
      });
    }
  }

  /**
   * Get agent name
   */
  get name(): string {
    return this.options.name;
  }

  /**
   * Get agent description
   */
  get description(): string | undefined {
    return this.options.description;
  }

  /**
   * Get agent goal
   */
  get goal(): string | undefined {
    return this.options.goal;
  }

  /**
   * Create a new route (journey)
   */
  createRoute(options: RouteOptions): Route<TContext> {
    const route = new Route<TContext>(options);
    this.routes.push(route);
    return route;
  }

  /**
   * Create a domain term for the glossary
   */
  createTerm(term: Term): this {
    this.terms.push(term);
    return this;
  }

  /**
   * Create a behavioral guideline
   */
  createGuideline(guideline: Guideline): this {
    const guidelineWithId = {
      ...guideline,
      id: guideline.id || `guideline_${this.guidelines.length}`,
      enabled: guideline.enabled !== false, // Default to true
    };
    this.guidelines.push(guidelineWithId);
    return this;
  }

  /**
   * Add a capability
   */
  createCapability(capability: Capability): this {
    const capabilityWithId = {
      ...capability,
      id: capability.id || `capability_${this.capabilities.length}`,
    };
    this.capabilities.push(capabilityWithId);
    return this;
  }

  /**
   * Create an observation for disambiguation
   */
  createObservation(description: string): Observation {
    const observation = new Observation({ description });
    this.observations.push(observation);
    return observation;
  }

  /**
   * Add a domain with its tools/methods
   */
  addDomain<TName extends string, TDomain extends Record<string, unknown>>(
    name: TName,
    domainObject: TDomain
  ): void {
    this.domainRegistry.register(name, domainObject);
    // Attach to the domain property for easy access
    this.domain[name] = domainObject;
  }

  /**
   * Update the agent's context
   * Triggers the onContextUpdate lifecycle hook if configured
   */
  async updateContext(updates: Partial<TContext>): Promise<void> {
    const previousContext = this.context;

    // Merge updates with current context
    this.context = {
      ...(this.context as Record<string, unknown>),
      ...(updates as Record<string, unknown>),
    } as TContext;

    // Trigger lifecycle hook if configured
    if (this.options.hooks?.onContextUpdate && previousContext !== undefined) {
      await this.options.hooks.onContextUpdate(this.context, previousContext);
    }
  }

  /**
   * Get current context (fetches from provider if configured)
   * @internal
   */
  private async getContext(): Promise<TContext | undefined> {
    // If context provider is configured, use it to fetch fresh context
    if (this.options.contextProvider) {
      return await this.options.contextProvider();
    }

    // Otherwise return the stored context
    return this.context;
  }

  /**
   * Generate a response based on history and context as a stream
   */
  async *respondStream(params: {
    history: Event[];
    state?: StateRef;
    contextOverride?: Partial<TContext>;
    signal?: AbortSignal;
  }): AsyncGenerator<{
    delta: string;
    accumulated: string;
    done: boolean;
    route?: { id: string; title: string } | null;
    state?: { id: string; description?: string } | null;
    toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
  }> {
    const { history, contextOverride, signal } = params;

    // Get current context (may fetch from provider)
    let currentContext = await this.getContext();

    // Call beforeRespond hook if configured
    if (this.options.hooks?.beforeRespond && currentContext !== undefined) {
      currentContext = await this.options.hooks.beforeRespond(currentContext);
      // Update stored context with the result from beforeRespond
      this.context = currentContext;
    }

    // Merge context with override
    const effectiveContext = {
      ...(currentContext as Record<string, unknown>),
      ...(contextOverride as Record<string, unknown>),
    } as TContext;

    // Build prompt (same as respond method)
    const promptBuilder = new PromptBuilder();

    // Add agent identity
    if (this.options.description) {
      promptBuilder.addAgentIdentity({
        name: this.options.name,
        description: this.options.description,
      });
    }

    // Add interaction history
    promptBuilder.addInteractionHistoryForMessageGeneration(history);

    // Add glossary
    if (this.terms.length > 0) {
      promptBuilder.addGlossary(this.terms);
    }

    // Add guidelines (convert to GuidelineMatch format, filter enabled only)
    const enabledGuidelines = this.guidelines.filter(
      (g) => g.enabled !== false
    );
    if (enabledGuidelines.length > 0) {
      const guidelineMatches: GuidelineMatch[] = enabledGuidelines.map((g) => ({
        guideline: g,
      }));
      promptBuilder.addGuidelinesForMessageGeneration(guidelineMatches);
    }

    // Add capabilities
    if (this.capabilities.length > 0) {
      promptBuilder.addCapabilitiesForMessageGeneration(this.capabilities);
    }

    // Add observations
    if (this.observations.length > 0) {
      const observationsWithRoutes = this.observations
        .map((obs) => ({
          description: obs.description,
          routes: obs.getRoutes().map((routeRef) => {
            const route = this.routes.find((r) => r.id === routeRef.id);
            return { title: route?.title || routeRef.id };
          }),
        }))
        .filter((obs) => obs.routes.length > 0);

      if (observationsWithRoutes.length > 0) {
        promptBuilder.addObservations(observationsWithRoutes);
      }
    }

    // Add active routes with their rules and prohibitions
    if (this.routes.length > 0) {
      promptBuilder.addActiveRoutes(
        this.routes.map((r) => ({
          title: r.title,
          description: r.description,
          conditions: r.conditions,
          domains: r.getDomains(),
          rules: r.getRules(),
          prohibitions: r.getProhibitions(),
        }))
      );
    }

    // Add domains (tools) information if any domains are registered
    const allDomains = this.domainRegistry.all();
    if (Object.keys(allDomains).length > 0) {
      promptBuilder.addDomains(allDomains);
    }

    // Add JSON response schema instructions
    promptBuilder.addJsonResponseSchema();

    // Build final prompt
    const prompt = promptBuilder.build();

    // Generate message stream using AI provider with JSON mode enabled
    const stream = this.options.ai.generateMessageStream({
      prompt,
      history,
      context: effectiveContext,
      signal,
      parameters: {
        jsonMode: true,
      },
    });

    // Stream chunks to caller
    for await (const chunk of stream) {
      // Extract route and state from structured response on final chunk
      let route: { id: string; title: string } | null = null;
      let state: { id: string; description?: string } | null = null;
      let toolCalls:
        | Array<{ toolName: string; arguments: Record<string, unknown> }>
        | undefined;

      if (chunk.done && chunk.structured) {
        // Find route by title
        if (chunk.structured.route) {
          const foundRoute = this.routes.find(
            (r) => r.title === chunk.structured?.route
          );
          if (foundRoute) {
            route = {
              id: foundRoute.id,
              title: foundRoute.title,
            };
          }
        }

        // Create state reference if provided
        if (chunk.structured.state) {
          state = {
            id: "dynamic_state",
            description: chunk.structured.state,
          };
        }

        // Extract tool calls
        if (
          chunk.structured.toolCalls &&
          chunk.structured.toolCalls.length > 0
        ) {
          toolCalls = chunk.structured.toolCalls;
        }
      }

      yield {
        delta: chunk.delta,
        accumulated: chunk.accumulated,
        done: chunk.done,
        route: route || undefined,
        state: state || undefined,
        toolCalls,
      };
    }
  }

  /**
   * Generate a response based on history and context
   */
  async respond(params: {
    history: Event[];
    state?: StateRef;
    contextOverride?: Partial<TContext>;
    signal?: AbortSignal;
  }): Promise<{
    message: string;
    route?: { id: string; title: string } | null;
    state?: { id: string; description?: string } | null;
    toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
  }> {
    const { history, contextOverride, signal } = params;

    // Get current context (may fetch from provider)
    let currentContext = await this.getContext();

    // Call beforeRespond hook if configured
    if (this.options.hooks?.beforeRespond && currentContext !== undefined) {
      currentContext = await this.options.hooks.beforeRespond(currentContext);
      // Update stored context with the result from beforeRespond
      this.context = currentContext;
    }

    // Merge context with override
    const effectiveContext = {
      ...(currentContext as Record<string, unknown>),
      ...(contextOverride as Record<string, unknown>),
    } as TContext;

    // Build prompt
    const promptBuilder = new PromptBuilder();

    // Add agent identity
    if (this.options.description) {
      promptBuilder.addAgentIdentity({
        name: this.options.name,
        description: this.options.description,
      });
    }

    // Add interaction history
    promptBuilder.addInteractionHistoryForMessageGeneration(history);

    // Add glossary
    if (this.terms.length > 0) {
      promptBuilder.addGlossary(this.terms);
    }

    // Add guidelines (convert to GuidelineMatch format, filter enabled only)
    const enabledGuidelines = this.guidelines.filter(
      (g) => g.enabled !== false
    );
    if (enabledGuidelines.length > 0) {
      const guidelineMatches: GuidelineMatch[] = enabledGuidelines.map((g) => ({
        guideline: g,
      }));
      promptBuilder.addGuidelinesForMessageGeneration(guidelineMatches);
    }

    // Add capabilities
    if (this.capabilities.length > 0) {
      promptBuilder.addCapabilitiesForMessageGeneration(this.capabilities);
    }

    // Add observations
    if (this.observations.length > 0) {
      const observationsWithRoutes = this.observations
        .map((obs) => ({
          description: obs.description,
          routes: obs.getRoutes().map((routeRef) => {
            const route = this.routes.find((r) => r.id === routeRef.id);
            return { title: route?.title || routeRef.id };
          }),
        }))
        .filter((obs) => obs.routes.length > 0);

      if (observationsWithRoutes.length > 0) {
        promptBuilder.addObservations(observationsWithRoutes);
      }
    }

    // Add active routes with their rules and prohibitions
    if (this.routes.length > 0) {
      promptBuilder.addActiveRoutes(
        this.routes.map((r) => ({
          title: r.title,
          description: r.description,
          conditions: r.conditions,
          domains: r.getDomains(),
          rules: r.getRules(),
          prohibitions: r.getProhibitions(),
        }))
      );
    }

    // Add domains (tools) information if any domains are registered
    const allDomains = this.domainRegistry.all();
    if (Object.keys(allDomains).length > 0) {
      promptBuilder.addDomains(allDomains);
    }

    // Add JSON response schema instructions
    promptBuilder.addJsonResponseSchema();

    // Build final prompt
    const prompt = promptBuilder.build();

    // Generate message using AI provider with JSON mode enabled
    const result = await this.options.ai.generateMessage({
      prompt,
      history,
      context: effectiveContext,
      signal,
      parameters: {
        jsonMode: true,
      },
    });

    // Parse structured response
    let message = result.message;
    let route: { id: string; title: string } | null = null;
    let state: { id: string; description?: string } | null = null;
    let toolCalls:
      | Array<{ toolName: string; arguments: Record<string, unknown> }>
      | undefined;

    if (result.structured) {
      // Extract data from structured response
      message = result.structured.message || message;

      // Find route by title
      if (result.structured.route) {
        const foundRoute = this.routes.find(
          (r) => r.title === result.structured?.route
        );
        if (foundRoute) {
          route = {
            id: foundRoute.id,
            title: foundRoute.title,
          };
        }
      }

      // Create state reference if provided
      if (result.structured.state) {
        state = {
          id: "dynamic_state",
          description: result.structured.state,
        };
      }

      // Extract tool calls
      if (
        result.structured.toolCalls &&
        result.structured.toolCalls.length > 0
      ) {
        toolCalls = result.structured.toolCalls;
      }
    }

    return {
      message,
      route: route || undefined,
      state: state || undefined,
      toolCalls,
    };
  }

  /**
   * Get all routes
   */
  getRoutes(): Route<TContext>[] {
    return [...this.routes];
  }

  /**
   * Get all terms
   */
  getTerms(): Term[] {
    return [...this.terms];
  }

  /**
   * Get all guidelines
   */
  getGuidelines(): Guideline[] {
    return [...this.guidelines];
  }

  /**
   * Get all capabilities
   */
  getCapabilities(): Capability[] {
    return [...this.capabilities];
  }

  /**
   * Get all observations
   */
  getObservations(): Observation[] {
    return [...this.observations];
  }

  /**
   * Get the domain registry
   */
  getDomainRegistry(): DomainRegistry {
    return this.domainRegistry;
  }

  /**
   * Get allowed domains for a specific route
   * @param routeId - Route ID to check
   * @returns Filtered domains object, or all domains if route has no restrictions
   */
  getDomainsForRoute(routeId: string): Record<string, Record<string, unknown>> {
    const route = this.routes.find((r) => r.id === routeId);

    if (!route) {
      // Route not found, return all domains
      return this.domainRegistry.all();
    }

    const allowedDomains = route.getDomains();
    return this.domainRegistry.getFiltered(allowedDomains);
  }

  /**
   * Get allowed domains for a specific route by title
   * @param routeTitle - Route title to check
   * @returns Filtered domains object, or all domains if route has no restrictions
   */
  getDomainsForRouteByTitle(
    routeTitle: string
  ): Record<string, Record<string, unknown>> {
    const route = this.routes.find((r) => r.title === routeTitle);

    if (!route) {
      // Route not found, return all domains
      return this.domainRegistry.all();
    }

    const allowedDomains = route.getDomains();
    return this.domainRegistry.getFiltered(allowedDomains);
  }
}
