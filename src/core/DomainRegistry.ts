/**
 * Domain registry for organizing agent capabilities by domain
 */

/**
 * Registry that holds domain-specific tools and methods
 */
export class DomainRegistry {
  private domains: Map<string, Record<string, unknown>> = new Map();

  /**
   * Register a new domain with its methods/tools
   */
  register<TDomain extends Record<string, unknown>>(
    name: string,
    domain: TDomain
  ): void {
    if (this.domains.has(name)) {
      throw new Error(`Domain "${name}" is already registered`);
    }
    this.domains.set(name, domain);
  }

  /**
   * Get a registered domain
   */
  get<TDomain extends Record<string, unknown>>(
    name: string
  ): TDomain | undefined {
    return this.domains.get(name) as TDomain | undefined;
  }

  /**
   * Check if a domain is registered
   */
  has(name: string): boolean {
    return this.domains.has(name);
  }

  /**
   * Get all registered domains as a single object
   */
  all(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const [name, domain] of this.domains) {
      result[name] = domain;
    }
    return result;
  }

  /**
   * Get filtered domains by names
   * @param allowedNames - Array of domain names to include (undefined = all domains)
   * @returns Object with only the specified domains
   */
  getFiltered(
    allowedNames?: string[]
  ): Record<string, Record<string, unknown>> {
    // If no filter specified, return all domains
    if (!allowedNames) {
      return this.all();
    }

    const result: Record<string, Record<string, unknown>> = {};
    for (const name of allowedNames) {
      const domain = this.domains.get(name);
      if (domain) {
        result[name] = domain;
      }
    }
    return result;
  }

  /**
   * Get list of all registered domain names
   */
  getDomainNames(): string[] {
    return Array.from(this.domains.keys());
  }
}
