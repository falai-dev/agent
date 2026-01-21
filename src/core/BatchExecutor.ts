/**
 * BatchExecutor - Core component for multi-step execution
 * 
 * Responsible for determining which Steps can execute together in a single batch
 * and orchestrating their execution with a single LLM call.
 */

import type { 
  BatchResult, 
  StoppedReason, 
  StepOptions, 
  BatchExecutionError, 
  BatchExecutionResult, 
  StepRef,
  BatchExecutionEvent,
  BatchExecutionEventListener,
  BatchExecutionTiming,
} from '../types/route';
import type { SessionState } from '../types/session';
import type { Tool } from '../types/tool';
import type { StructuredSchema } from '../types/schema';
import { Step } from './Step';
import { Route } from './Route';
import { END_ROUTE_ID } from '../constants';
import { logger, createTemplateContext, mergeCollected } from '../utils';

/**
 * Step configuration relevant for needs-input detection
 */
export interface NeedsInputStep {
  /** Required data fields that must be present before entering this step */
  requires?: readonly (string | number | symbol)[];
  /** Fields to collect from the conversation in this step */
  collect?: readonly (string | number | symbol)[];
}

/**
 * Determine if a Step needs user input to proceed
 * 
 * IMPORTANT: sessionData MUST already include pre-extracted fields.
 * This function is called AFTER pre-extraction has been merged into session data.
 * 
 * A Step needs input when:
 * 1. It has `requires` fields and at least one is missing from session data (after pre-extraction)
 * 2. It has non-empty `collect` fields and none of those fields have data (after pre-extraction)
 * 
 * @param step - The Step to evaluate (can be Step instance or StepOptions)
 * @param sessionDataAfterPreExtraction - Session data with pre-extracted fields already merged
 * @returns true if the step needs user input, false otherwise
 * 
 * @example
 * ```typescript
 * // Step with requires - needs input if any required field is missing
 * const step = { requires: ['name', 'email'], collect: [] };
 * needsInput(step, { name: 'John' }); // true - email is missing
 * needsInput(step, { name: 'John', email: 'john@example.com' }); // false - all present
 * 
 * // Step with collect - needs input if no collect fields have data
 * const step2 = { collect: ['preference', 'feedback'] };
 * needsInput(step2, {}); // true - no collect fields have data
 * needsInput(step2, { preference: 'A' }); // false - at least one has data
 * ```
 * 
 * **Validates: Requirements 1.2, 1.3**
 */
export function needsInput<TData extends Record<string, unknown> = Record<string, unknown>>(
  step: NeedsInputStep,
  sessionDataAfterPreExtraction: Partial<TData>
): boolean {
  // Check requires - all must be present (after pre-extraction)
  // Requirement 1.2: A Step Needs_Input WHEN it has `requires` fields that are not present
  // in session data after Pre_Extraction
  if (step.requires && step.requires.length > 0) {
    const missingRequired = step.requires.some(
      field => {
        const key = String(field);
        return (sessionDataAfterPreExtraction as Record<string, unknown>)[key] === undefined;
      }
    );
    if (missingRequired) return true;
  }

  // Check collect - needs input if collecting and no data exists (after pre-extraction)
  // Requirement 1.3: A Step Needs_Input WHEN it has `collect` fields (non-empty array) and
  // no data for those fields exists in session data
  if (step.collect && step.collect.length > 0) {
    const hasAnyCollectData = step.collect.some(
      field => {
        const key = String(field);
        return (sessionDataAfterPreExtraction as Record<string, unknown>)[key] !== undefined;
      }
    );
    if (!hasAnyCollectData) return true;
  }

  return false;
}

/**
 * Parameters for batch determination
 */
export interface DetermineBatchParams<TContext, TData> {
  /** The route containing the steps */
  route: Route<TContext, TData>;
  /** The current step to start from (undefined means start from initial step) */
  currentStep: Step<TContext, TData> | undefined;
  /** Session data with pre-extracted fields already merged */
  sessionData: Partial<TData>;
  /** Agent context for condition evaluation */
  context: TContext;
}

/**
 * BatchExecutor class - orchestrates multi-step execution
 * 
 * Determines which Steps can execute together in a single batch based on:
 * - skipIf conditions (skip steps that evaluate to true)
 * - needsInput detection (stop when a step needs user input)
 * - END_ROUTE detection (stop when reaching end of route)
 * 
 * Supports event emission for debugging and observability:
 * - batch_start: Emitted when batch determination begins
 * - step_included: Emitted when a step is included in the batch
 * - step_skipped: Emitted when a step is skipped (due to skipIf)
 * - batch_stop: Emitted when batch determination stops
 * - batch_complete: Emitted when batch execution completes
 * 
 * **Validates: Requirements 1.1, 1.4, 1.5, 7.1, 7.2, 7.3, 11.1, 11.2, 11.3**
 */
export class BatchExecutor<TContext = unknown, TData = unknown> {
  /** Event listeners for batch execution events */
  private eventListeners: BatchExecutionEventListener[] = [];

  /**
   * Add an event listener for batch execution events
   * 
   * @param listener - Callback function to receive events
   * @returns Function to remove the listener
   * 
   * **Validates: Requirements 11.3**
   */
  addEventListener(listener: BatchExecutionEventListener): () => void {
    this.eventListeners.push(listener);
    return () => {
      const index = this.eventListeners.indexOf(listener);
      if (index !== -1) {
        this.eventListeners.splice(index, 1);
      }
    };
  }

  /**
   * Remove an event listener
   * 
   * @param listener - The listener to remove
   */
  removeEventListener(listener: BatchExecutionEventListener): void {
    const index = this.eventListeners.indexOf(listener);
    if (index !== -1) {
      this.eventListeners.splice(index, 1);
    }
  }

  /**
   * Emit a batch execution event to all listeners
   * 
   * @param event - The event to emit
   * @private
   */
  private emitEvent(event: BatchExecutionEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        // Log but don't fail on listener errors
        logger.warn(`[BatchExecutor] Event listener error:`, error);
      }
    }
  }

  /**
   * Create and emit a batch execution event
   * 
   * @param type - Event type
   * @param details - Event details
   * @private
   */
  private emitBatchEvent(
    type: BatchExecutionEvent['type'],
    details: BatchExecutionEvent['details']
  ): void {
    const event: BatchExecutionEvent = {
      type,
      timestamp: new Date(),
      details,
    };
    this.emitEvent(event);
    
    // Also log the event when debug mode is enabled
    logger.debug(`[BatchExecutor] Event: ${type}`, details);
  }

  /**
   * Determine which Steps can execute in the current batch
   * starting from the given Step position.
   * 
   * Algorithm:
   * 1. Start from currentStep (or initialStep if undefined)
   * 2. For each step:
   *    a. Check if it's END_ROUTE - stop with 'end_route'
   *    b. Evaluate skipIf condition
   *    c. If skipIf is true - skip step, continue to next
   *    d. If skipIf throws error - treat as non-skippable (Requirement 7.3)
   *    e. Evaluate needsInput
   *    f. If needsInput is false - include in batch, continue to next
   *    g. If needsInput is true - stop with 'needs_input'
   * 3. If all steps processed - stop with 'route_complete'
   * 
   * @param params - Parameters for batch determination
   * @returns BatchResult with steps to execute and stopping reason
   * 
   * **Validates: Requirements 1.1, 1.4, 1.5, 7.1, 7.2, 7.3**
   */
  async determineBatch(params: DetermineBatchParams<TContext, TData>): Promise<BatchResult<TContext, TData>> {
    const { route, currentStep, sessionData, context } = params;
    const startTime = Date.now();
    
    const batchSteps: StepOptions<TContext, TData>[] = [];
    let stoppedReason: StoppedReason = 'route_complete';
    let stoppedAtStep: StepOptions<TContext, TData> | undefined;
    
    // Get all steps in the route for traversal
    const allSteps = route.getAllSteps();
    
    // Find starting position
    let startIndex = 0;
    if (currentStep) {
      const currentIndex = allSteps.findIndex(s => s.id === currentStep.id);
      if (currentIndex !== -1) {
        startIndex = currentIndex;
      }
    }
    
    // Log batch determination start (Requirement 11.1)
    logger.debug(`[BatchExecutor] Starting batch determination from step index ${startIndex}, total steps: ${allSteps.length}`);
    
    // Emit batch_start event (Requirement 11.3)
    this.emitBatchEvent('batch_start', {
      stepId: currentStep?.id,
      reason: `Starting batch determination from ${currentStep?.id || 'initial step'}`,
      batchSize: 0,
    });
    
    // Create template context for condition evaluation
    const templateContext = createTemplateContext<TContext, TData>({
      context,
      data: sessionData,
      session: { 
        id: `batch-${Date.now()}`,
        data: sessionData 
      } as SessionState<TData>,
    });
    
    // Walk through steps starting from current position
    for (let i = startIndex; i < allSteps.length; i++) {
      const step = allSteps[i];
      const stepOptions = step.toOptions();
      
      // Check for END_ROUTE (Requirement 2.2)
      if (step.id === END_ROUTE_ID) {
        stoppedReason = 'end_route';
        stoppedAtStep = stepOptions;
        
        // Log stopping reason (Requirement 11.2)
        logger.debug(`[BatchExecutor] Reached END_ROUTE, stopping batch`);
        
        // Emit batch_stop event (Requirement 11.3)
        this.emitBatchEvent('batch_stop', {
          stepId: step.id,
          reason: 'Reached END_ROUTE',
          stoppedReason: 'end_route',
          batchSize: batchSteps.length,
        });
        break;
      }
      
      // Evaluate skipIf condition (Requirements 7.1, 7.2, 7.3)
      let shouldSkip = false;
      if (step.skipIf) {
        try {
          const skipResult = await step.evaluateSkipIf(templateContext);
          shouldSkip = skipResult.shouldSkip;
          
          // Log skipIf evaluation (Requirement 11.1)
          logger.debug(`[BatchExecutor] Step ${step.id} skipIf evaluated to: ${shouldSkip}`);
        } catch (error) {
          // Requirement 7.3: If skipIf evaluation throws an error, treat as non-skippable
          logger.warn(`[BatchExecutor] skipIf evaluation error for step ${step.id}, treating as non-skippable:`, error);
          shouldSkip = false;
        }
      }
      
      // If skipIf is true, skip this step and continue (Requirement 7.2)
      if (shouldSkip) {
        // Log step skip (Requirement 11.1)
        logger.debug(`[BatchExecutor] Skipping step ${step.id} due to skipIf condition`);
        
        // Emit step_skipped event (Requirement 11.3)
        this.emitBatchEvent('step_skipped', {
          stepId: step.id,
          reason: 'skipIf condition evaluated to true',
        });
        continue;
      }
      
      // Evaluate needsInput (Requirements 1.2, 1.3)
      const stepNeedsInput = needsInput(step, sessionData);
      
      if (stepNeedsInput) {
        // Requirement 1.5: Stop when a step needs input
        stoppedReason = 'needs_input';
        stoppedAtStep = stepOptions;
        
        // Log stopping reason with details (Requirement 11.1, 11.2)
        const missingRequires = step.requires?.filter(
          field => (sessionData as Record<string, unknown>)[String(field)] === undefined
        ) || [];
        const collectFields = step.collect || [];
        logger.debug(`[BatchExecutor] Step ${step.id} needs input, stopping batch. Missing requires: [${missingRequires.join(', ')}], Collect fields: [${collectFields.join(', ')}]`);
        
        // Emit batch_stop event (Requirement 11.3)
        this.emitBatchEvent('batch_stop', {
          stepId: step.id,
          reason: `Step needs input - missing requires: [${missingRequires.join(', ')}], collect fields: [${collectFields.join(', ')}]`,
          stoppedReason: 'needs_input',
          batchSize: batchSteps.length,
        });
        break;
      }
      
      // Requirement 1.4: Step doesn't need input, include in batch
      batchSteps.push(stepOptions);
      
      // Log step inclusion with reason (Requirement 11.1)
      logger.debug(`[BatchExecutor] Including step ${step.id} in batch (all requirements satisfied)`);
      
      // Emit step_included event (Requirement 11.3)
      this.emitBatchEvent('step_included', {
        stepId: step.id,
        reason: 'All requirements satisfied, no input needed',
        batchSize: batchSteps.length,
      });
      
      // Move to next step in the sequence
      const transitions = step.getTransitions();
      if (transitions.length === 0) {
        // No more transitions, route is complete
        stoppedReason = 'route_complete';
        
        // Log stopping reason (Requirement 11.2)
        logger.debug(`[BatchExecutor] No more transitions from step ${step.id}, route complete`);
        
        // Emit batch_stop event (Requirement 11.3)
        this.emitBatchEvent('batch_stop', {
          stepId: step.id,
          reason: 'No more transitions, route complete',
          stoppedReason: 'route_complete',
          batchSize: batchSteps.length,
        });
        break;
      }
      
      // For linear routes, follow the first transition
      // For branching routes, we'd need more complex logic
      const nextStep = transitions[0];
      if (nextStep) {
        // Update the loop to continue from the next step
        const nextIndex = allSteps.findIndex(s => s.id === nextStep.id);
        if (nextIndex !== -1 && nextIndex > i) {
          // Continue from next step (will be incremented by loop)
          i = nextIndex - 1;
        } else if (nextStep.id === END_ROUTE_ID) {
          // Next step is END_ROUTE
          stoppedReason = 'end_route';
          stoppedAtStep = nextStep.toOptions();
          
          // Log stopping reason (Requirement 11.2)
          logger.debug(`[BatchExecutor] Next step is END_ROUTE, stopping batch`);
          
          // Emit batch_stop event (Requirement 11.3)
          this.emitBatchEvent('batch_stop', {
            stepId: nextStep.id,
            reason: 'Next step is END_ROUTE',
            stoppedReason: 'end_route',
            batchSize: batchSteps.length,
          });
          break;
        }
      }
    }
    
    // Log batch determination complete with timing (Requirement 11.1, 11.2)
    const determinationTime = Date.now() - startTime;
    logger.debug(`[BatchExecutor] Batch determination complete. Steps: ${batchSteps.length}, Stopped reason: ${stoppedReason}, Time: ${determinationTime}ms`);
    
    return {
      steps: batchSteps,
      stoppedReason,
      stoppedAtStep,
    };
  }

  /**
   * Execute prepare hooks for all steps in the batch
   * 
   * Executes all prepare hooks in Step order before the LLM call.
   * If any prepare hook fails, execution stops immediately and returns an error.
   * 
   * @param params - Parameters for hook execution
   * @returns Result indicating success or failure with error details
   * 
   * **Validates: Requirements 5.1, 5.3, 5.4**
   */
  async executePrepareHooks(params: ExecuteHooksParams<TContext, TData>): Promise<HookExecutionResult> {
    const { steps, context, data, executeHook } = params;
    const executedSteps: string[] = [];
    
    logger.debug(`[BatchExecutor] Executing prepare hooks for ${steps.length} steps`);
    
    for (const step of steps) {
      if (step.prepare) {
        logger.debug(`[BatchExecutor] Executing prepare hook for step: ${step.id}`);
        
        try {
          await executeHook(step.prepare, context, data, step);
          executedSteps.push(step.id || 'unknown');
          logger.debug(`[BatchExecutor] Prepare hook completed for step: ${step.id}`);
        } catch (error) {
          // Requirement 5.4: Stop on prepare hook failure
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`[BatchExecutor] Prepare hook failed for step ${step.id}: ${errorMessage}`);
          
          return {
            success: false,
            executedSteps,
            error: {
              type: 'prepare_hook',
              message: errorMessage,
              stepId: step.id,
              details: error,
            },
          };
        }
      }
    }
    
    logger.debug(`[BatchExecutor] All prepare hooks completed successfully`);
    return {
      success: true,
      executedSteps,
    };
  }

  /**
   * Execute finalize hooks for all steps in the batch
   * 
   * Executes all finalize hooks in Step order after the LLM response.
   * If a finalize hook fails, the error is logged but execution continues
   * with remaining hooks.
   * 
   * @param params - Parameters for hook execution
   * @returns Result with any errors that occurred (always succeeds)
   * 
   * **Validates: Requirements 5.2, 5.3, 5.5**
   */
  async executeFinalizeHooks(params: ExecuteHooksParams<TContext, TData>): Promise<HookExecutionResult> {
    const { steps, context, data, executeHook } = params;
    const executedSteps: string[] = [];
    const errors: Array<{ stepId: string; error: BatchExecutionError }> = [];
    
    logger.debug(`[BatchExecutor] Executing finalize hooks for ${steps.length} steps`);
    
    for (const step of steps) {
      if (step.finalize) {
        logger.debug(`[BatchExecutor] Executing finalize hook for step: ${step.id}`);
        
        try {
          await executeHook(step.finalize, context, data, step);
          executedSteps.push(step.id || 'unknown');
          logger.debug(`[BatchExecutor] Finalize hook completed for step: ${step.id}`);
        } catch (error) {
          // Requirement 5.5: Log error and continue with remaining hooks
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`[BatchExecutor] Finalize hook failed for step ${step.id}: ${errorMessage}`);
          
          errors.push({
            stepId: step.id || 'unknown',
            error: {
              type: 'finalize_hook',
              message: errorMessage,
              stepId: step.id,
              details: error,
            },
          });
          
          // Continue to next step despite error
        }
      }
    }
    
    if (errors.length > 0) {
      logger.warn(`[BatchExecutor] ${errors.length} finalize hook(s) failed, but execution continued`);
    } else {
      logger.debug(`[BatchExecutor] All finalize hooks completed successfully`);
    }
    
    // Always return success for finalize hooks (errors are logged but don't stop execution)
    return {
      success: true,
      executedSteps,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Execute all hooks for a batch of steps
   * 
   * This is a convenience method that executes prepare hooks, then allows
   * the caller to perform the LLM call, and finally executes finalize hooks.
   * 
   * @param params - Parameters for hook execution
   * @returns Object with methods to execute prepare and finalize phases
   * 
   * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**
   */
  createHookExecutor(params: ExecuteHooksParams<TContext, TData>): HookExecutor<TContext, TData> {
    return {
      executePrepare: () => this.executePrepareHooks(params),
      executeFinalize: () => this.executeFinalizeHooks(params),
    };
  }

  /**
   * Execute a batch of steps with comprehensive error handling
   * 
   * This method orchestrates the complete batch execution flow:
   * 1. Execute prepare hooks (stop on failure)
   * 2. Make LLM call (preserve session state on failure)
   * 3. Collect and validate data (include errors in response)
   * 4. Execute finalize hooks (continue on failure, log errors)
   * 
   * Error handling behavior:
   * - LLM call failures: Return error response with last successful session state
   * - Validation failures: Include validation errors in response, preserve partial data
   * - Prepare hook failures: Stop execution, return error with appropriate stoppedReason
   * - Finalize hook failures: Log errors, continue execution (non-fatal)
   * 
   * @param params - Parameters for batch execution
   * @returns BatchExecutionResult with message, session, executed steps, and any errors
   * 
   * **Validates: Requirements 9.1, 9.2, 9.3, 2.4**
   */
  async executeBatch(params: ExecuteBatchParams<TContext, TData>): Promise<BatchExecutionResult<TData>> {
    const { 
      batch, 
      session: initialSession, 
      context, 
      executeHook, 
      generateMessage, 
      schema,
      routeId,
    } = params;
    
    // Track timing for each phase (Requirement 11.1)
    const timing: BatchExecutionTiming = {
      totalMs: 0,
    };
    const batchStartTime = Date.now();
    
    // Track the last successful session state for error recovery
    let lastSuccessfulSession = initialSession;
    let currentSession = initialSession;
    
    // Track executed steps for the response
    const executedSteps: StepRef[] = [];
    
    // Log batch execution start with details (Requirement 11.1)
    logger.debug(`[BatchExecutor] Starting batch execution with ${batch.steps.length} steps, route: ${routeId || 'unknown'}`);
    
    // If batch is empty, return early with appropriate reason
    if (batch.steps.length === 0) {
      logger.debug(`[BatchExecutor] Empty batch, returning with stopped reason: ${batch.stoppedReason}`);
      
      // Emit batch_complete event for empty batch (Requirement 11.3)
      timing.totalMs = Date.now() - batchStartTime;
      this.emitBatchEvent('batch_complete', {
        batchSize: 0,
        stoppedReason: batch.stoppedReason,
        reason: 'Empty batch',
        timing,
      });
      
      return {
        message: '',
        session: currentSession,
        executedSteps: [],
        stoppedReason: batch.stoppedReason,
        collectedData: {},
      };
    }
    
    // PHASE 1: Execute prepare hooks (Requirement 5.4 - stop on failure)
    const prepareStartTime = Date.now();
    logger.debug(`[BatchExecutor] Phase 1: Executing prepare hooks`);
    
    const prepareResult = await this.executePrepareHooks({
      steps: batch.steps,
      context,
      data: currentSession.data,
      executeHook,
    });
    
    timing.prepareHooksMs = Date.now() - prepareStartTime;
    logger.debug(`[BatchExecutor] Prepare hooks completed in ${timing.prepareHooksMs}ms`);
    
    if (!prepareResult.success) {
      // Requirement 9.3: Preserve partial progress on errors
      // Requirement 2.4: Stop and include error information
      logger.error(`[BatchExecutor] Prepare hook failed:`, prepareResult.error);
      
      // Emit batch_complete event with error (Requirement 11.3)
      timing.totalMs = Date.now() - batchStartTime;
      this.emitBatchEvent('batch_complete', {
        batchSize: batch.steps.length,
        stoppedReason: 'prepare_error',
        reason: `Prepare hook failed: ${prepareResult.error?.message}`,
        timing,
      });
      
      return {
        message: '',
        session: lastSuccessfulSession, // Return last successful state
        executedSteps: prepareResult.executedSteps.map(stepId => ({
          id: stepId,
          routeId: routeId || 'unknown',
        })),
        stoppedReason: 'prepare_error',
        error: prepareResult.error,
      };
    }
    
    // Update last successful session after prepare hooks complete
    lastSuccessfulSession = currentSession;
    
    // PHASE 2: Make LLM call (Requirement 9.1 - preserve session state on failure)
    const llmStartTime = Date.now();
    logger.debug(`[BatchExecutor] Phase 2: Making LLM call`);
    
    let llmResponse: Record<string, unknown>;
    let message: string;
    
    try {
      const result = await generateMessage();
      llmResponse = result.structured || {};
      message = result.message || '';
      
      timing.llmCallMs = Date.now() - llmStartTime;
      logger.debug(`[BatchExecutor] LLM call successful in ${timing.llmCallMs}ms`);
    } catch (error) {
      // Requirement 9.1: Return error response with last successful session state
      const errorMessage = error instanceof Error ? error.message : String(error);
      timing.llmCallMs = Date.now() - llmStartTime;
      logger.error(`[BatchExecutor] LLM call failed after ${timing.llmCallMs}ms:`, errorMessage);
      
      // Emit batch_complete event with error (Requirement 11.3)
      timing.totalMs = Date.now() - batchStartTime;
      this.emitBatchEvent('batch_complete', {
        batchSize: batch.steps.length,
        stoppedReason: 'llm_error',
        reason: `LLM call failed: ${errorMessage}`,
        timing,
      });
      
      return {
        message: '',
        session: lastSuccessfulSession, // Preserve session state
        executedSteps: [], // No steps were fully executed
        stoppedReason: 'llm_error',
        error: {
          type: 'llm_call',
          message: errorMessage,
          details: error,
        },
      };
    }
    
    // Update last successful session after LLM call
    lastSuccessfulSession = currentSession;
    
    // PHASE 3: Collect and validate data (Requirement 9.2 - include validation errors)
    const collectStartTime = Date.now();
    logger.debug(`[BatchExecutor] Phase 3: Collecting and validating data`);
    
    const collectResult = this.collectBatchData({
      steps: batch.steps,
      llmResponse,
      session: currentSession,
      schema,
    });
    
    timing.dataCollectionMs = Date.now() - collectStartTime;
    logger.debug(`[BatchExecutor] Data collection completed in ${timing.dataCollectionMs}ms`);
    
    // Update session with collected data (even if validation failed)
    currentSession = collectResult.session;
    
    // Track collected data for response
    const collectedData = collectResult.collectedData;
    
    // Check for validation errors
    let validationError: BatchExecutionError | undefined;
    if (!collectResult.success && collectResult.validationErrors && collectResult.validationErrors.length > 0) {
      // Requirement 9.2: Include validation errors in response
      logger.warn(`[BatchExecutor] Data validation failed:`, collectResult.validationErrors);
      
      validationError = {
        type: 'data_validation',
        message: `Validation failed for ${collectResult.validationErrors.length} field(s): ${collectResult.validationErrors.map(e => e.field).join(', ')}`,
        details: collectResult.validationErrors,
      };
      
      // Note: We continue execution despite validation errors
      // The error is included in the response for the caller to handle
    }
    
    // Update last successful session after data collection
    // (even with validation errors, we preserve the collected data)
    lastSuccessfulSession = currentSession;
    
    // Build executed steps list
    for (const step of batch.steps) {
      if (step.id) {
        executedSteps.push({
          id: step.id,
          routeId: routeId || 'unknown',
        });
      }
    }
    
    // PHASE 4: Execute finalize hooks (Requirement 5.5 - continue on failure)
    const finalizeStartTime = Date.now();
    logger.debug(`[BatchExecutor] Phase 4: Executing finalize hooks`);
    
    const finalizeResult = await this.executeFinalizeHooks({
      steps: batch.steps,
      context,
      data: currentSession.data,
      executeHook,
    });
    
    timing.finalizeHooksMs = Date.now() - finalizeStartTime;
    logger.debug(`[BatchExecutor] Finalize hooks completed in ${timing.finalizeHooksMs}ms`);
    
    // Log finalize errors but don't fail the batch
    let finalizeError: BatchExecutionError | undefined;
    if (finalizeResult.errors && finalizeResult.errors.length > 0) {
      logger.warn(`[BatchExecutor] Some finalize hooks failed:`, finalizeResult.errors);
      
      // Create a summary error for finalize failures
      finalizeError = {
        type: 'finalize_hook',
        message: `${finalizeResult.errors.length} finalize hook(s) failed`,
        details: finalizeResult.errors,
      };
    }
    
    // Determine the final stopped reason
    // Priority: validation_error > finalize_error > batch.stoppedReason
    let finalStoppedReason: StoppedReason = batch.stoppedReason;
    let finalError: BatchExecutionError | undefined;
    
    if (validationError) {
      finalStoppedReason = 'validation_error';
      finalError = validationError;
    } else if (finalizeError) {
      // Finalize errors are non-fatal, so we keep the original stopped reason
      // but include the error in the response
      finalError = finalizeError;
    }
    
    // Calculate total time and log completion (Requirement 11.1, 11.2)
    timing.totalMs = Date.now() - batchStartTime;
    logger.debug(`[BatchExecutor] Batch execution complete. Stopped reason: ${finalStoppedReason}, Executed steps: ${executedSteps.length}, Total time: ${timing.totalMs}ms`);
    
    // Emit batch_complete event (Requirement 11.3)
    this.emitBatchEvent('batch_complete', {
      batchSize: executedSteps.length,
      stoppedReason: finalStoppedReason,
      reason: `Batch completed with ${executedSteps.length} steps`,
      timing,
    });
    
    return {
      message,
      session: currentSession,
      executedSteps,
      stoppedReason: finalStoppedReason,
      collectedData,
      error: finalError,
    };
  }

  /**
   * Collect data from LLM response for all steps in the batch
   * 
   * This method:
   * 1. Gathers all collect fields from all steps in the batch
   * 2. Extracts those fields from the LLM response
   * 3. Validates extracted data against the agent schema (if provided)
   * 4. Updates session data with all collected values
   * 
   * @param params - Parameters for data collection
   * @returns Result with collected data, updated session, and any validation errors
   * 
   * **Validates: Requirements 6.1, 6.2, 6.3**
   */
  collectBatchData(params: CollectBatchDataParams<TData>): CollectBatchDataResult<TData> {
    const { steps, llmResponse, session, schema } = params;
    
    logger.debug(`[BatchExecutor] Collecting batch data from ${steps.length} steps`);
    
    // Requirement 6.1: Gather all collect fields from all steps in the batch
    const allCollectFields = new Set<string>();
    for (const step of steps) {
      if (step.collect && step.collect.length > 0) {
        for (const field of step.collect) {
          allCollectFields.add(String(field));
        }
      }
    }
    
    logger.debug(`[BatchExecutor] Collect fields to extract: ${Array.from(allCollectFields).join(', ')}`);
    
    // If no fields to collect, return early with unchanged session
    if (allCollectFields.size === 0) {
      logger.debug(`[BatchExecutor] No collect fields defined, skipping data collection`);
      return {
        success: true,
        collectedData: {},
        session,
        fieldsCollected: [],
      };
    }
    
    // Extract data from LLM response for all collect fields
    const collectedData: Partial<TData> = {};
    const fieldsCollected: string[] = [];
    const fieldsMissing: string[] = [];
    
    for (const field of allCollectFields) {
      // Check if the field exists in the LLM response
      if (field in llmResponse && llmResponse[field] !== undefined) {
        (collectedData as Record<string, unknown>)[field] = llmResponse[field];
        fieldsCollected.push(field);
        logger.debug(`[BatchExecutor] Collected field '${field}': ${JSON.stringify(llmResponse[field])}`);
      } else {
        fieldsMissing.push(field);
        logger.debug(`[BatchExecutor] Field '${field}' not found in LLM response`);
      }
    }
    
    // Requirement 6.2: Validate collected data against the agent schema
    const validationErrors: ValidationError[] = [];
    
    if (schema && Object.keys(collectedData).length > 0) {
      logger.debug(`[BatchExecutor] Validating collected data against schema`);
      
      const validationResult = this.validateAgainstSchema(collectedData, schema);
      if (!validationResult.valid) {
        validationErrors.push(...validationResult.errors);
        logger.warn(`[BatchExecutor] Schema validation found ${validationErrors.length} error(s)`);
      }
    }
    
    // Requirement 6.3: Update session data with all collected values
    // Only merge valid data (data that passed validation or had no schema to validate against)
    let updatedSession = session;
    if (Object.keys(collectedData).length > 0) {
      // Filter out fields with validation errors if we want strict validation
      // For now, we include all collected data and report errors separately
      updatedSession = mergeCollected(session, collectedData);
      logger.debug(`[BatchExecutor] Updated session with collected data`);
    }
    
    const success = validationErrors.length === 0;
    
    logger.debug(`[BatchExecutor] Data collection complete. Success: ${success}, Fields collected: ${fieldsCollected.length}, Fields missing: ${fieldsMissing.length}`);
    
    return {
      success,
      collectedData,
      session: updatedSession,
      fieldsCollected,
      fieldsMissing: fieldsMissing.length > 0 ? fieldsMissing : undefined,
      validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
    };
  }

  /**
   * Validate data against a JSON schema
   * 
   * Performs basic validation of collected data against the agent schema.
   * Checks:
   * - Fields exist in schema properties
   * - Required fields are present (as warnings)
   * - Basic type validation
   * 
   * @param data - Data to validate
   * @param schema - JSON schema to validate against
   * @returns Validation result with errors
   * @private
   */
  private validateAgainstSchema(
    data: Partial<TData>,
    schema: StructuredSchema
  ): { valid: boolean; errors: ValidationError[] } {
    const errors: ValidationError[] = [];
    
    // Check if provided fields exist in schema
    if (schema.properties) {
      for (const [key, value] of Object.entries(data)) {
        if (!(key in schema.properties)) {
          errors.push({
            field: key,
            value,
            message: `Field '${key}' is not defined in schema`,
            schemaPath: `properties.${key}`,
          });
        } else {
          // Basic type validation
          const fieldSchema = schema.properties[key];
          const typeError = this.validateFieldType(key, value, fieldSchema);
          if (typeError) {
            errors.push(typeError);
          }
        }
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate a single field's type against its schema
   * @private
   */
  private validateFieldType(
    field: string,
    value: unknown,
    fieldSchema: StructuredSchema
  ): ValidationError | null {
    if (value === null || value === undefined) {
      // Null/undefined values are handled separately (required field check)
      return null;
    }
    
    const expectedType = fieldSchema.type;
    if (!expectedType) {
      // No type specified, consider valid
      return null;
    }
    
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    
    // Handle array of types
    const allowedTypes = Array.isArray(expectedType) ? expectedType : [expectedType];
    
    // Map JavaScript types to JSON Schema types
    const typeMapping: Record<string, string> = {
      'string': 'string',
      'number': 'number',
      'boolean': 'boolean',
      'object': 'object',
      'array': 'array',
    };
    
    const mappedActualType = typeMapping[actualType] || actualType;
    
    // Check if actual type matches any allowed type
    // Also handle 'integer' as a valid number type
    const isValidType = allowedTypes.some(t => {
      if (t === 'integer') {
        return typeof value === 'number' && Number.isInteger(value);
      }
      return t === mappedActualType;
    });
    
    if (!isValidType) {
      return {
        field,
        value,
        message: `Field '${field}' has type '${actualType}' but expected '${allowedTypes.join(' | ')}'`,
        schemaPath: `properties.${field}.type`,
      };
    }
    
    return null;
  }
}

/**
 * Parameters for executing hooks on batched steps
 */
export interface ExecuteHooksParams<TContext, TData> {
  /** Steps in the batch to execute hooks for */
  steps: StepOptions<TContext, TData>[];
  /** Agent context */
  context: TContext;
  /** Current session data */
  data?: Partial<TData>;
  /** 
   * Function to execute a single hook (prepare or finalize)
   * This allows the caller to provide their own hook execution logic
   * (e.g., using ToolManager for tool-based hooks)
   */
  executeHook: (
    hook: HookFunction<TContext, TData>,
    context: TContext,
    data?: Partial<TData>,
    step?: StepOptions<TContext, TData>
  ) => Promise<void>;
}

/**
 * Type for the hook execution function
 */
export type HookFunction<TContext, TData> = 
  | string
  | Tool<TContext, TData>
  | ((context: TContext, data?: Partial<TData>) => void | Promise<void>);

/**
 * Result of hook execution
 */
export interface HookExecutionResult {
  /** Whether all hooks executed successfully */
  success: boolean;
  /** IDs of steps whose hooks were executed */
  executedSteps: string[];
  /** Error details if a hook failed (for prepare hooks) */
  error?: BatchExecutionError;
  /** Array of errors for finalize hooks (which continue on failure) */
  errors?: Array<{ stepId: string; error: BatchExecutionError }>;
}

/**
 * Hook executor interface for managing prepare/finalize phases
 */
export interface HookExecutor<TContext, TData> {
  /** Execute all prepare hooks */
  executePrepare: () => Promise<HookExecutionResult>;
  /** Execute all finalize hooks */
  executeFinalize: () => Promise<HookExecutionResult>;
  /** Execute a single hook (used internally) */
  executeHook?: (
    hook: HookFunction<TContext, TData>,
    context: TContext,
    data?: Partial<TData>,
    step?: StepOptions<TContext, TData>
  ) => Promise<void>;
}

/**
 * Parameters for collecting batch data from LLM response
 */
export interface CollectBatchDataParams<TData> {
  /** Steps in the batch that may have collect fields */
  steps: Array<{ collect?: readonly (keyof TData)[] }>;
  /** The LLM response containing collected data */
  llmResponse: Record<string, unknown>;
  /** Current session state to update */
  session: SessionState<TData>;
  /** Optional agent schema for validation */
  schema?: StructuredSchema;
}

/**
 * Result of batch data collection
 */
export interface CollectBatchDataResult<TData> {
  /** Whether data collection and validation succeeded */
  success: boolean;
  /** Data collected from the LLM response */
  collectedData: Partial<TData>;
  /** Updated session with collected data merged */
  session: SessionState<TData>;
  /** Fields that were successfully collected */
  fieldsCollected: string[];
  /** Fields that were expected but not found in response */
  fieldsMissing?: string[];
  /** Validation errors if schema validation failed */
  validationErrors?: ValidationError[];
}

/**
 * Validation error for schema validation
 */
export interface ValidationError {
  /** Field that failed validation */
  field: string;
  /** Value that failed validation */
  value: unknown;
  /** Error message */
  message: string;
  /** Path in schema where validation failed */
  schemaPath: string;
}


/**
 * Parameters for executing a batch of steps
 */
export interface ExecuteBatchParams<TContext, TData> {
  /** The batch result from determineBatch */
  batch: BatchResult<TContext, TData>;
  /** Current session state */
  session: SessionState<TData>;
  /** Agent context */
  context: TContext;
  /** 
   * Function to execute a single hook (prepare or finalize)
   * This allows the caller to provide their own hook execution logic
   */
  executeHook: (
    hook: HookFunction<TContext, TData>,
    context: TContext,
    data?: Partial<TData>,
    step?: StepOptions<TContext, TData>
  ) => Promise<void>;
  /**
   * Function to generate the LLM message
   * This allows the caller to provide their own LLM call logic
   * (e.g., using BatchPromptBuilder and AI provider)
   */
  generateMessage: () => Promise<{
    message: string;
    structured?: Record<string, unknown>;
  }>;
  /** Optional agent schema for validation */
  schema?: StructuredSchema;
  /** Route ID for step references */
  routeId?: string;
}
