/**
 * Prompt building types
 */

/**
 * Status of a prompt section
 */
export enum SectionStatus {
  /** Section has active information */
  ACTIVE = "active",
  /** Section is inactive but may have empty-state text */
  PASSIVE = "passive",
  /** Section is not included */
  NONE = "none",
}

/**
 * A section within a prompt
 */
export interface PromptSection {
  /** Template string (may contain placeholders) */
  template: string;
  /** Properties to fill template placeholders */
  props: Record<string, unknown>;
  /** Status of this section */
  status?: SectionStatus;
}

/**
 * Context variable with value
 */
export interface ContextVariable {
  /** Variable name */
  name: string;
  /** Variable description */
  description?: string;
  /** Variable type */
  type?: string;
}

/**
 * Value for a context variable
 */
export interface ContextVariableValue {
  /** The variable definition */
  variable: ContextVariable;
  /** The current value */
  value: unknown;
}
