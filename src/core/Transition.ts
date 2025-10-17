/**
 * Transition between steps in the route DSL
 */

import type {
  StepRef,
  TransitionSpec,
  InlineToolHandler,
} from "../types/route";
import type { Step } from "./Step";
import type { ToolRef, ToolResult, ToolContext } from "../types/tool";
import { generateInlineToolId } from "../utils/id";

/**
 * Represents a transition from one step to another
 */
export class Transition<TContext = unknown, TData = unknown> {
  private target?: Step<TContext, TData>;
  public readonly condition?: string;

  constructor(
    public readonly source: StepRef,
    public readonly spec: TransitionSpec<TContext, TData>
  ) {
    // Extract condition from spec for convenience
    this.condition = spec.condition;

    // Normalize tool if present
    if (spec.tool) {
      this.spec = {
        ...spec,
        tool: this.normalizeTool(spec.tool, source.id),
      };
    }
  }
  /**
   * Normalize tool - convert inline handler to ToolRef if needed
   */
  private normalizeTool<TContext, TData>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool:
      | ToolRef<TContext, any[], any, TData>
      | InlineToolHandler<TContext, TData>,
    stepId: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): ToolRef<TContext, any[], any, TData> {
    // If it's already a ToolRef (has id and name properties), return as-is
    if (typeof tool === "object" && "id" in tool && "name" in tool) {
      return tool;
    }

    // Otherwise, it's an inline handler function - wrap it in a ToolRef
    const inlineHandler = tool;
    const toolId = generateInlineToolId(stepId);

    return {
      id: toolId,
      name: toolId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (
        context: ToolContext<TContext, TData>
      ): Promise<ToolResult<any, TContext, TData>> => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (await inlineHandler(context)) as ToolResult<
          any,
          TContext,
          TData
        >;
        return {
          data: result,
        };
      },
      description: `Inline tool for step ${stepId}`,
    };
  }

  /**
   * Set the target step for this transition
   */
  setTarget(step: Step<TContext, TData>): void {
    this.target = step;
  }

  /**
   * Get the target step
   */
  getTarget(): Step<TContext, TData> | undefined {
    return this.target;
  }

  /**
   * Get transition description for logging/debugging
   */
  describe(): string {
    const parts: string[] = [];

    if (this.spec.instructions) {
      parts.push(`chat: "${this.spec.instructions}"`);
    }
    if (this.spec.tool) {
      parts.push(`tool: ${this.spec.tool.name}`);
    }
    if (this.spec.step) {
      if (typeof this.spec.step === "symbol") {
        parts.push("step: END_ROUTE");
      } else {
        parts.push(`step: ${this.spec.step.id}`);
      }
    }

    const transition = parts.join(", ");
    const conditionPart = this.condition ? ` (when: ${this.condition})` : "";

    return `${this.source.id} -> [${transition}]${conditionPart}`;
  }
}
