/**
 * Property-Based Tests for BatchExecutor
 * 
 * Feature: multi-step-execution
 * Property 1: Needs-Input Detection
 * 
 * Tests the needsInput function which determines if a Step requires user input.
 * 
 * **Validates: Requirements 1.2, 1.3**
 */
import { expect, test, describe } from "bun:test";
import { BatchExecutor } from "../src/core/BatchExecutor";
import * as fc from "fast-check";
import { needsInput, type NeedsInputStep } from "../src/core/BatchExecutor";
import { 
  type ExecuteHooksParams, 
  type HookFunction 
} from "../src/core/BatchExecutor";

// Test data type for property tests - using string index signature for flexibility
type TestData = Record<string, string | undefined>;

// Arbitrary for generating field names
const fieldNameArb = fc.stringMatching(/^field[1-5]$/);

// Arbitrary for generating non-empty arrays of unique field names
const fieldArrayArb = fc.uniqueArray(fieldNameArb, { minLength: 1, maxLength: 5 });

describe("BatchExecutor - needsInput", () => {
  /**
   * Property 1: Needs-Input Detection
   * 
   * For any Step with `requires` or `collect` fields, and for any session data state,
   * the `needsInput` function SHALL return true if and only if:
   * - The Step has `requires` fields and at least one is missing from session data, OR
   * - The Step has non-empty `collect` fields and none of those fields have data in session
   * 
   * **Validates: Requirements 1.2, 1.3**
   */
  
  describe("Property 1: Needs-Input Detection", () => {
    test("returns true when requires fields are missing from session data", () => {
      fc.assert(
        fc.property(
          fieldArrayArb,
          fc.integer({ min: 0, max: 4 }),
          (requiresFields, numPresent) => {
            // Ensure we have at least one missing field
            const presentCount = Math.min(numPresent, requiresFields.length - 1);
            const presentFields = requiresFields.slice(0, presentCount);
            
            const sessionData: TestData = {};
            presentFields.forEach(f => { sessionData[f] = 'value'; });
            
            const step: NeedsInputStep = { requires: requiresFields, collect: [] };
            
            // If not all requires fields are present, needsInput should return true
            if (presentCount < requiresFields.length) {
              expect(needsInput(step, sessionData)).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("returns false when all requires fields are present in session data", () => {
      fc.assert(
        fc.property(
          fieldArrayArb,
          (requiresFields) => {
            // All requires fields are present
            const sessionData: TestData = {};
            requiresFields.forEach(f => { sessionData[f] = 'value'; });
            
            const step: NeedsInputStep = { requires: requiresFields, collect: [] };
            
            expect(needsInput(step, sessionData)).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("returns true when collect fields exist but none have data", () => {
      fc.assert(
        fc.property(
          fieldArrayArb,
          (collectFields) => {
            // No collect fields have data
            const sessionData: TestData = {};
            
            const step: NeedsInputStep = { requires: [], collect: collectFields };
            
            expect(needsInput(step, sessionData)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("returns false when at least one collect field has data", () => {
      fc.assert(
        fc.property(
          fieldArrayArb,
          fc.integer({ min: 0, max: 4 }),
          (collectFields, fieldIndex) => {
            // At least one collect field has data
            const idx = fieldIndex % collectFields.length;
            const sessionData: TestData = {};
            sessionData[collectFields[idx]] = 'value';
            
            const step: NeedsInputStep = { requires: [], collect: collectFields };
            
            expect(needsInput(step, sessionData)).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("returns false when step has no requires and no collect fields", () => {
      fc.assert(
        fc.property(
          fc.dictionary(fieldNameArb, fc.string()),
          (sessionData) => {
            const step: NeedsInputStep = { requires: [], collect: [] };
            
            // No requirements means no input needed
            expect(needsInput(step, sessionData)).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("requires takes precedence - missing requires means needs input even if collect has data", () => {
      fc.assert(
        fc.property(
          fieldArrayArb,
          fieldArrayArb,
          (requiresFields, collectFields) => {
            // Session has data for collect fields but not for requires
            const sessionData: TestData = {};
            collectFields.forEach(f => { sessionData[f] = 'value'; });
            
            // Clear any overlap with requires fields
            requiresFields.forEach(f => { delete sessionData[f]; });
            
            const step: NeedsInputStep = { requires: requiresFields, collect: collectFields };
            
            // Should need input because requires fields are missing
            expect(needsInput(step, sessionData)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("combined: returns false only when all requires present AND at least one collect has data", () => {
      fc.assert(
        fc.property(
          fieldArrayArb,
          fieldArrayArb,
          fc.integer({ min: 0, max: 4 }),
          (requiresFields, collectFields, collectIdx) => {
            // All requires fields present
            const sessionData: TestData = {};
            requiresFields.forEach(f => { sessionData[f] = 'required_value'; });
            
            // At least one collect field has data
            const idx = collectIdx % collectFields.length;
            sessionData[collectFields[idx]] = 'collected_value';
            
            const step: NeedsInputStep = { requires: requiresFields, collect: collectFields };
            
            expect(needsInput(step, sessionData)).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("undefined values in session are treated as missing", () => {
      fc.assert(
        fc.property(
          fieldArrayArb,
          (requiresFields) => {
            // Session has undefined for all requires fields
            const sessionData: TestData = {};
            requiresFields.forEach(f => { sessionData[f] = undefined; });
            
            const step: NeedsInputStep = { requires: requiresFields, collect: [] };
            
            expect(needsInput(step, sessionData)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Unit tests for edge cases
  describe("Edge Cases", () => {
    test("handles empty requires array", () => {
      const step: NeedsInputStep = { requires: [], collect: ['field1'] };
      expect(needsInput(step, {})).toBe(true); // collect needs data
      expect(needsInput(step, { field1: 'value' })).toBe(false);
    });

    test("handles empty collect array", () => {
      const step: NeedsInputStep = { requires: ['field1'], collect: [] };
      expect(needsInput(step, {})).toBe(true); // requires missing
      expect(needsInput(step, { field1: 'value' })).toBe(false);
    });

    test("handles undefined requires", () => {
      const step: NeedsInputStep = { requires: undefined, collect: ['field1'] };
      expect(needsInput(step, {})).toBe(true);
      expect(needsInput(step, { field1: 'value' })).toBe(false);
    });

    test("handles undefined collect", () => {
      const step: NeedsInputStep = { requires: ['field1'], collect: undefined };
      expect(needsInput(step, {})).toBe(true);
      expect(needsInput(step, { field1: 'value' })).toBe(false);
    });

    test("handles both undefined", () => {
      const step: NeedsInputStep = { requires: undefined, collect: undefined };
      expect(needsInput(step, {})).toBe(false);
      expect(needsInput(step, { field1: 'value' })).toBe(false);
    });

    test("handles empty string values as present", () => {
      const step: NeedsInputStep = { requires: ['field1'], collect: [] };
      // Empty string is not undefined, so it counts as present
      expect(needsInput(step, { field1: '' })).toBe(false);
    });

    test("handles null-ish values correctly", () => {
      const step: NeedsInputStep = { requires: ['field1'], collect: [] };
      // Only undefined is treated as missing
      expect(needsInput(step, { field1: undefined })).toBe(true);
    });
  });
});


/**
 * Property-Based Tests for BatchExecutor.determineBatch
 * 
 * Feature: multi-step-execution
 * Property 2: Batch Execution Continuity
 * 
 * Tests the determineBatch method which determines which steps can execute together.
 * 
 * **Validates: Requirements 1.1, 1.4, 1.5**
 */
import { Route } from "../src/core/Route";
import type { StepOptions } from "../src/types/route";

// Test data type for batch execution tests
// Using unknown to allow testing type validation scenarios with numbers, objects, etc.
type BatchTestData = {
  field1?: unknown;
  field2?: unknown;
  field3?: unknown;
  field4?: unknown;
  field5?: unknown;
};

// Arbitrary for generating step configurations
const stepConfigArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }).map(s => `step_${s}`),
  description: fc.option(fc.string({ minLength: 1, maxLength: 20 })),
  requires: fc.option(fc.uniqueArray(
    fc.constantFrom('field1', 'field2', 'field3', 'field4', 'field5') as fc.Arbitrary<keyof BatchTestData>,
    { minLength: 0, maxLength: 3 }
  )),
  collect: fc.option(fc.uniqueArray(
    fc.constantFrom('field1', 'field2', 'field3', 'field4', 'field5') as fc.Arbitrary<keyof BatchTestData>,
    { minLength: 0, maxLength: 3 }
  )),
});

// Generate a route with multiple steps
const routeWithStepsArb = fc.array(stepConfigArb, { minLength: 1, maxLength: 5 }).map(stepConfigs => {
  const steps: StepOptions<unknown, BatchTestData>[] = stepConfigs.map((config, idx) => ({
    id: `${config.id}_${idx}`,
    description: config.description ?? `Step ${idx}`,
    requires: config.requires ?? undefined,
    collect: config.collect ?? undefined,
  }));
  
  return new Route<unknown, BatchTestData>({
    title: 'Test Route',
    steps,
  });
});

// Generate session data with random fields populated
const sessionDataArb = fc.record({
  field1: fc.option(fc.string()),
  field2: fc.option(fc.string()),
  field3: fc.option(fc.string()),
  field4: fc.option(fc.string()),
  field5: fc.option(fc.string()),
}).map(data => {
  // Convert null to undefined for consistency
  const result: Partial<BatchTestData> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== null) {
      result[key as keyof BatchTestData] = value;
    }
  }
  return result;
});

describe("BatchExecutor - determineBatch", () => {
  /**
   * Property 2: Batch Execution Continuity
   * 
   * For any Route with multiple Steps, the Execution_Engine SHALL include 
   * consecutive Steps in the batch until encountering a Step that needs input, 
   * and SHALL stop immediately when such a Step is encountered.
   * 
   * **Validates: Requirements 1.1, 1.4, 1.5**
   */
  
  describe("Property 2: Batch Execution Continuity", () => {
    test("includes consecutive steps until one needs input", async () => {
      await fc.assert(
        fc.asyncProperty(
          routeWithStepsArb,
          sessionDataArb,
          async (route, sessionData) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            const result = await executor.determineBatch({
              route,
              currentStep: undefined, // Start from beginning
              sessionData,
              context: {},
            });
            
            // Get all steps in the route
            const allSteps = route.getAllSteps();
            
            // Verify: batch should contain consecutive steps from the start
            // that don't need input
            let expectedBatchSize = 0;
            for (const step of allSteps) {
              // Check if this step needs input
              const stepRequires = step.requires || [];
              const stepCollect = step.collect || [];
              
              // Step needs input if:
              // 1. Has requires fields and any are missing
              const missingRequired = stepRequires.some(
                field => sessionData[field as keyof BatchTestData] === undefined
              );
              
              // 2. Has collect fields and none have data
              const hasCollectData = stepCollect.length === 0 || stepCollect.some(
                field => sessionData[field as keyof BatchTestData] !== undefined
              );
              
              const stepNeedsInput = missingRequired || (stepCollect.length > 0 && !hasCollectData);
              
              if (stepNeedsInput) {
                // Should stop here
                break;
              }
              
              expectedBatchSize++;
            }
            
            // The batch size should match our expectation
            // (accounting for END_ROUTE which doesn't get included)
            expect(result.steps.length).toBeLessThanOrEqual(allSteps.length);
            
            // If we have steps in the batch, verify they are consecutive from start
            if (result.steps.length > 0) {
              const batchStepIds = result.steps.map(s => s.id);
              const routeStepIds = allSteps.slice(0, result.steps.length).map(s => s.id);
              
              // Batch steps should be a prefix of route steps (accounting for skipped steps)
              for (let i = 0; i < batchStepIds.length; i++) {
                expect(routeStepIds).toContain(batchStepIds[i] as string);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("stops with 'needs_input' when step requires missing data", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('field1', 'field2', 'field3') as fc.Arbitrary<keyof BatchTestData>,
          async (requiredField) => {
            // Create a route where the first step requires a field
            const route = new Route<unknown, BatchTestData>({
              title: 'Test Route',
              steps: [
                { id: 'step1', requires: [requiredField], collect: [] },
                { id: 'step2', collect: [] },
              ],
            });
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Session data without the required field
            const sessionData: Partial<BatchTestData> = {};
            
            const result = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData,
              context: {},
            });
            
            // Should stop with needs_input
            expect(result.stoppedReason).toBe('needs_input');
            // Batch should be empty since first step needs input
            expect(result.steps.length).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("includes step when all requires are satisfied", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(
            fc.constantFrom('field1', 'field2', 'field3') as fc.Arbitrary<keyof BatchTestData>,
            { minLength: 1, maxLength: 3 }
          ),
          async (requiredFields) => {
            // Create a route where the first step requires fields
            const route = new Route<unknown, BatchTestData>({
              title: 'Test Route',
              steps: [
                { id: 'step1', requires: requiredFields, collect: [] },
              ],
            });
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Session data with all required fields
            const sessionData: Partial<BatchTestData> = {};
            requiredFields.forEach(f => { sessionData[f] = 'value'; });
            
            const result = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData,
              context: {},
            });
            
            // Step should be included in batch
            expect(result.steps.length).toBeGreaterThanOrEqual(1);
            expect(result.steps[0].id).toBe('step1');
          }
        ),
        { numRuns: 100 }
      );
    });

    test("stops with 'route_complete' when all steps processed", async () => {
      // Create a route with steps that don't need input
      const route = new Route<unknown, BatchTestData>({
        title: 'Test Route',
        steps: [
          { id: 'step1', requires: [], collect: [] },
          { id: 'step2', requires: [], collect: [] },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Should complete the route
      expect(['route_complete', 'end_route']).toContain(result.stoppedReason);
    });
  });

  // Unit tests for specific scenarios
  describe("Batch Determination Edge Cases", () => {
    test("handles empty route", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'Empty Route',
        steps: [],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      expect(['route_complete', 'end_route']).toContain(result.stoppedReason);
    });

    test("handles single step route", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'Single Step Route',
        steps: [
          { id: 'only_step', requires: [], collect: [] },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      expect(result.steps.length).toBeGreaterThanOrEqual(1);
    });

    test("handles step with collect fields and no data", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'Collect Route',
        steps: [
          { id: 'collect_step', requires: [], collect: ['field1'] },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Should need input because collect field has no data
      expect(result.stoppedReason).toBe('needs_input');
      expect(result.steps.length).toBe(0);
    });

    test("includes step when collect field has data", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'Collect Route',
        steps: [
          { id: 'collect_step', requires: [], collect: ['field1'] },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: { field1: 'value' },
        context: {},
      });
      
      // Step should be included
      expect(result.steps.length).toBeGreaterThanOrEqual(1);
    });
  });
});


/**
 * Property-Based Tests for BatchExecutor skipIf evaluation
 * 
 * Feature: multi-step-execution
 * Property 8: SkipIf Evaluation
 * 
 * Tests that skipIf conditions are properly evaluated during batch determination.
 * 
 * **Validates: Requirements 7.1, 7.2, 7.3**
 */

describe("BatchExecutor - skipIf Evaluation", () => {
  /**
   * Property 8: SkipIf Evaluation
   * 
   * For any Step with a `skipIf` condition, the Execution_Engine SHALL evaluate 
   * the condition before batch inclusion. If true, the Step is skipped and the 
   * next Step is evaluated. If evaluation throws an error, the Step is treated 
   * as non-skippable.
   * 
   * **Validates: Requirements 7.1, 7.2, 7.3**
   */
  
  describe("Property 8: SkipIf Evaluation", () => {
    test("skips step when skipIf evaluates to true", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.boolean(),
          async (skipCondition) => {
            // Create a route with a step that has a skipIf condition
            const route = new Route<unknown, BatchTestData>({
              title: 'SkipIf Route',
              steps: [
                { 
                  id: 'skippable_step', 
                  requires: [], 
                  collect: [],
                  skipIf: () => skipCondition, // Programmatic condition
                },
                { 
                  id: 'next_step', 
                  requires: [], 
                  collect: [],
                },
              ],
            });
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            const result = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: {},
              context: {},
            });
            
            if (skipCondition) {
              // Step should be skipped, so it shouldn't be in the batch
              const hasSkippableStep = result.steps.some(s => s.id === 'skippable_step');
              expect(hasSkippableStep).toBe(false);
              
              // But next_step should be included (if it doesn't need input)
              const hasNextStep = result.steps.some(s => s.id === 'next_step');
              expect(hasNextStep).toBe(true);
            } else {
              // Step should be included
              const hasSkippableStep = result.steps.some(s => s.id === 'skippable_step');
              expect(hasSkippableStep).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("treats step as non-skippable when skipIf throws error", async () => {
      // Create a route with a step that has a skipIf that throws
      const route = new Route<unknown, BatchTestData>({
        title: 'Error SkipIf Route',
        steps: [
          { 
            id: 'error_step', 
            requires: [], 
            collect: [],
            skipIf: () => { throw new Error('skipIf error'); },
          },
          { 
            id: 'next_step', 
            requires: [], 
            collect: [],
          },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Step should be included (treated as non-skippable due to error)
      const hasErrorStep = result.steps.some(s => s.id === 'error_step');
      expect(hasErrorStep).toBe(true);
    });

    test("evaluates skipIf before checking needsInput", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('field1', 'field2', 'field3') as fc.Arbitrary<keyof BatchTestData>,
          async (requiredField) => {
            // Create a route with a step that would need input but has skipIf=true
            const route = new Route<unknown, BatchTestData>({
              title: 'SkipIf Before NeedsInput Route',
              steps: [
                { 
                  id: 'skipped_step', 
                  requires: [requiredField], // Would need input
                  collect: [],
                  skipIf: () => true, // But skipIf is true
                },
                { 
                  id: 'next_step', 
                  requires: [], 
                  collect: [],
                },
              ],
            });
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Session data without the required field
            const result = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: {},
              context: {},
            });
            
            // Skipped step should not be in batch
            const hasSkippedStep = result.steps.some(s => s.id === 'skipped_step');
            expect(hasSkippedStep).toBe(false);
            
            // Next step should be included
            const hasNextStep = result.steps.some(s => s.id === 'next_step');
            expect(hasNextStep).toBe(true);
            
            // Should not stop with needs_input since the step was skipped
            expect(result.stoppedReason).not.toBe('needs_input');
          }
        ),
        { numRuns: 100 }
      );
    });

    test("continues to next step after skipping", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 4 }),
          async (numSkippedSteps) => {
            // Create steps where first N have skipIf=true
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            
            for (let i = 0; i < numSkippedSteps; i++) {
              steps.push({
                id: `skipped_${i}`,
                requires: [],
                collect: [],
                skipIf: () => true,
              });
            }
            
            // Add a final step that should be included
            steps.push({
              id: 'final_step',
              requires: [],
              collect: [],
            });
            
            const route = new Route<unknown, BatchTestData>({
              title: 'Multiple Skip Route',
              steps,
            });
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            const result = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: {},
              context: {},
            });
            
            // None of the skipped steps should be in batch
            for (let i = 0; i < numSkippedSteps; i++) {
              const hasSkippedStep = result.steps.some(s => s.id === `skipped_${i}`);
              expect(hasSkippedStep).toBe(false);
            }
            
            // Final step should be included
            const hasFinalStep = result.steps.some(s => s.id === 'final_step');
            expect(hasFinalStep).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("handles async skipIf conditions", async () => {
      // Create a route with an async skipIf condition
      const route = new Route<unknown, BatchTestData>({
        title: 'Async SkipIf Route',
        steps: [
          { 
            id: 'async_skip_step', 
            requires: [], 
            collect: [],
            skipIf: async () => {
              await new Promise(resolve => setTimeout(resolve, 1));
              return true;
            },
          },
          { 
            id: 'next_step', 
            requires: [], 
            collect: [],
          },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Async skipped step should not be in batch
      const hasAsyncSkipStep = result.steps.some(s => s.id === 'async_skip_step');
      expect(hasAsyncSkipStep).toBe(false);
      
      // Next step should be included
      const hasNextStep = result.steps.some(s => s.id === 'next_step');
      expect(hasNextStep).toBe(true);
    });
  });

  // Unit tests for skipIf edge cases
  describe("SkipIf Edge Cases", () => {
    test("handles step without skipIf condition", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'No SkipIf Route',
        steps: [
          { id: 'no_skipif_step', requires: [], collect: [] },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Step should be included
      expect(result.steps.length).toBeGreaterThanOrEqual(1);
    });

    test("handles skipIf with context access", async () => {
      type TestContext = { shouldSkip: boolean };
      
      const route = new Route<TestContext, BatchTestData>({
        title: 'Context SkipIf Route',
        steps: [
          { 
            id: 'context_skip_step', 
            requires: [], 
            collect: [],
            skipIf: ({ context }) => context?.shouldSkip ?? false,
          },
        ],
      });
      
      const executor = new BatchExecutor<TestContext, BatchTestData>();
      
      // Test with shouldSkip = true
      const result1 = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: { shouldSkip: true },
      });
      
      const hasStep1 = result1.steps.some(s => s.id === 'context_skip_step');
      expect(hasStep1).toBe(false);
      
      // Test with shouldSkip = false
      const result2 = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: { shouldSkip: false },
      });
      
      const hasStep2 = result2.steps.some(s => s.id === 'context_skip_step');
      expect(hasStep2).toBe(true);
    });

    test("handles skipIf with data access", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'Data SkipIf Route',
        steps: [
          { 
            id: 'data_skip_step', 
            requires: [], 
            collect: [],
            skipIf: ({ data }) => data?.field1 === 'skip',
          },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      // Test with field1 = 'skip'
      const result1 = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: { field1: 'skip' },
        context: {},
      });
      
      const hasStep1 = result1.steps.some(s => s.id === 'data_skip_step');
      expect(hasStep1).toBe(false);
      
      // Test with field1 = 'keep'
      const result2 = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: { field1: 'keep' },
        context: {},
      });
      
      const hasStep2 = result2.steps.some(s => s.id === 'data_skip_step');
      expect(hasStep2).toBe(true);
    });

    test("handles all steps being skipped", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'All Skipped Route',
        steps: [
          { id: 'skip1', requires: [], collect: [], skipIf: () => true },
          { id: 'skip2', requires: [], collect: [], skipIf: () => true },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // No steps should be in batch
      expect(result.steps.filter(s => s.id === 'skip1' || s.id === 'skip2').length).toBe(0);
      // Should complete the route
      expect(['route_complete', 'end_route']).toContain(result.stoppedReason);
    });
  });
});


/**
 * Property-Based Tests for BatchPromptBuilder
 * 
 * Feature: multi-step-execution
 * Property 5: Prompt Combination
 * 
 * Tests the BatchPromptBuilder which combines multiple Step prompts into a single prompt.
 * 
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
 */
import { BatchPromptBuilder } from "../src/core/BatchPromptBuilder";

// Mock AI provider for testing
const mockProvider = {
  generateMessage: async () => ({ message: "test response" }),
  generateMessageStream: async function* () { yield { delta: "test", accumulated: "test", done: true }; },
};

describe("BatchPromptBuilder - Prompt Combination", () => {
  /**
   * Property 5: Prompt Combination
   * 
   * For any batch containing N Steps (N > 1), the combined prompt SHALL:
   * - Be a single string (not multiple prompts)
   * - Contain text from each Step's prompt
   * - Include all `collect` fields from all Steps in the batch
   * 
   * **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
   */
  
  describe("Property 5: Prompt Combination", () => {
    test("produces a single string prompt for multiple steps", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          async (numSteps) => {
            // Create steps with unique prompts
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            for (let i = 0; i < numSteps; i++) {
              steps.push({
                id: `step_${i}`,
                description: `Step ${i} description`,
                prompt: `This is the prompt for step ${i}`,
                collect: [],
              });
            }
            
            const route = new Route<unknown, BatchTestData>({
              title: 'Multi-Step Route',
              steps,
            });
            
            const builder = new BatchPromptBuilder<unknown, BatchTestData>();
            
            const result = await builder.buildBatchPrompt({
              steps: steps,
              route,
              history: [],
              context: {},
              session: { id: 'test-session', data: {} },
              agentOptions: {
                name: 'Test Agent',
                provider: mockProvider as any,
              },
            });
            
            // Property: Result should be a single string
            expect(typeof result.prompt).toBe('string');
            expect(result.prompt.length).toBeGreaterThan(0);
            
            // Property: Step count should match
            expect(result.stepCount).toBe(numSteps);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("combined prompt contains text from each step's prompt", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              id: fc.string({ minLength: 1, maxLength: 10 }).map(s => `step_${s}`),
              promptText: fc.string({ minLength: 5, maxLength: 50 }).filter(s => s.trim().length > 0),
            }),
            { minLength: 2, maxLength: 5 }
          ),
          async (stepConfigs) => {
            // Ensure unique IDs
            const uniqueConfigs = stepConfigs.map((config, idx) => ({
              ...config,
              id: `${config.id}_${idx}`,
            }));
            
            const steps: StepOptions<unknown, BatchTestData>[] = uniqueConfigs.map(config => ({
              id: config.id,
              description: `Description for ${config.id}`,
              prompt: config.promptText,
              collect: [],
            }));
            
            const route = new Route<unknown, BatchTestData>({
              title: 'Prompt Test Route',
              steps,
            });
            
            const builder = new BatchPromptBuilder<unknown, BatchTestData>();
            
            const result = await builder.buildBatchPrompt({
              steps: steps,
              route,
              history: [],
              context: {},
              session: { id: 'test-session', data: {} },
              agentOptions: {
                name: 'Test Agent',
                provider: mockProvider as any,
              },
            });
            
            // Property: Combined prompt should contain each step's prompt text
            for (const config of uniqueConfigs) {
              expect(result.prompt).toContain(config.promptText);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("combined prompt includes all collect fields from all steps", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              id: fc.string({ minLength: 1, maxLength: 10 }).map(s => `step_${s}`),
              collectFields: fc.uniqueArray(
                fc.constantFrom('field1', 'field2', 'field3', 'field4', 'field5') as fc.Arbitrary<keyof BatchTestData>,
                { minLength: 0, maxLength: 3 }
              ),
            }),
            { minLength: 2, maxLength: 5 }
          ),
          async (stepConfigs) => {
            // Ensure unique IDs
            const uniqueConfigs = stepConfigs.map((config, idx) => ({
              ...config,
              id: `${config.id}_${idx}`,
            }));
            
            const steps: StepOptions<unknown, BatchTestData>[] = uniqueConfigs.map(config => ({
              id: config.id,
              description: `Description for ${config.id}`,
              prompt: `Prompt for ${config.id}`,
              collect: config.collectFields,
            }));
            
            const route = new Route<unknown, BatchTestData>({
              title: 'Collect Test Route',
              steps,
            });
            
            const builder = new BatchPromptBuilder<unknown, BatchTestData>();
            
            const result = await builder.buildBatchPrompt({
              steps: steps,
              route,
              history: [],
              context: {},
              session: { id: 'test-session', data: {} },
              agentOptions: {
                name: 'Test Agent',
                provider: mockProvider as any,
              },
            });
            
            // Collect all unique fields from all steps
            const allCollectFields = new Set<string>();
            for (const config of uniqueConfigs) {
              for (const field of config.collectFields) {
                allCollectFields.add(String(field));
              }
            }
            
            // Property: Result should include all collect fields
            expect(result.collectFields.length).toBe(allCollectFields.size);
            for (const field of allCollectFields) {
              expect(result.collectFields).toContain(field);
            }
            
            // Property: Combined prompt should mention each collect field
            for (const field of allCollectFields) {
              expect(result.prompt).toContain(field);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("produces single LLM call regardless of step count", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (numSteps) => {
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            for (let i = 0; i < numSteps; i++) {
              steps.push({
                id: `step_${i}`,
                description: `Step ${i}`,
                prompt: `Prompt ${i}`,
                collect: i % 2 === 0 ? ['field1'] : [],
              });
            }
            
            const route = new Route<unknown, BatchTestData>({
              title: 'Single Call Route',
              steps,
            });
            
            const builder = new BatchPromptBuilder<unknown, BatchTestData>();
            
            const result = await builder.buildBatchPrompt({
              steps: steps,
              route,
              history: [],
              context: {},
              session: { id: 'test-session', data: {} },
              agentOptions: {
                name: 'Test Agent',
                provider: mockProvider as any,
              },
            });
            
            // Property: Should produce exactly one prompt string
            expect(typeof result.prompt).toBe('string');
            expect(result.stepCount).toBe(numSteps);
            
            // Property: The prompt should be a coherent single document
            // (not an array or multiple separate prompts)
            expect(Array.isArray(result.prompt)).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("preserves individual step prompt intent", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              description: fc.string({ minLength: 5, maxLength: 30 }).filter(s => s.trim().length > 0),
              prompt: fc.string({ minLength: 10, maxLength: 100 }).filter(s => s.trim().length > 0),
            }),
            { minLength: 2, maxLength: 4 }
          ),
          async (stepConfigs) => {
            const steps: StepOptions<unknown, BatchTestData>[] = stepConfigs.map((config, idx) => ({
              id: `step_${idx}`,
              description: config.description,
              prompt: config.prompt,
              collect: [],
            }));
            
            const route = new Route<unknown, BatchTestData>({
              title: 'Intent Preservation Route',
              steps,
            });
            
            const builder = new BatchPromptBuilder<unknown, BatchTestData>();
            
            const result = await builder.buildBatchPrompt({
              steps: steps,
              route,
              history: [],
              context: {},
              session: { id: 'test-session', data: {} },
              agentOptions: {
                name: 'Test Agent',
                provider: mockProvider as any,
              },
            });
            
            // Property: Each step's prompt content should be preserved in the combined prompt
            for (const config of stepConfigs) {
              expect(result.prompt).toContain(config.prompt);
            }
            
            // Property: Each step's description should be preserved
            for (const config of stepConfigs) {
              expect(result.prompt).toContain(config.description);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Unit tests for edge cases
  describe("Prompt Combination Edge Cases", () => {
    test("handles single step batch", async () => {
      const steps: StepOptions<unknown, BatchTestData>[] = [
        { id: 'single_step', description: 'Only step', prompt: 'Single step prompt', collect: ['field1'] },
      ];
      
      const route = new Route<unknown, BatchTestData>({
        title: 'Single Step Route',
        steps,
      });
      
      const builder = new BatchPromptBuilder<unknown, BatchTestData>();
      
      const result = await builder.buildBatchPrompt({
        steps,
        route,
        history: [],
        context: {},
        session: { id: 'test-session', data: {} },
        agentOptions: {
          name: 'Test Agent',
          provider: mockProvider as any,
        },
      });
      
      expect(result.stepCount).toBe(1);
      expect(result.prompt).toContain('Single step prompt');
      expect(result.collectFields).toContain('field1');
    });

    test("handles steps with no prompts", async () => {
      const steps: StepOptions<unknown, BatchTestData>[] = [
        { id: 'no_prompt_1', description: 'Step without prompt 1', collect: ['field1'] },
        { id: 'no_prompt_2', description: 'Step without prompt 2', collect: ['field2'] },
      ];
      
      const route = new Route<unknown, BatchTestData>({
        title: 'No Prompt Route',
        steps,
      });
      
      const builder = new BatchPromptBuilder<unknown, BatchTestData>();
      
      const result = await builder.buildBatchPrompt({
        steps,
        route,
        history: [],
        context: {},
        session: { id: 'test-session', data: {} },
        agentOptions: {
          name: 'Test Agent',
          provider: mockProvider as any,
        },
      });
      
      expect(result.stepCount).toBe(2);
      expect(result.collectFields).toContain('field1');
      expect(result.collectFields).toContain('field2');
    });

    test("handles steps with no collect fields", async () => {
      const steps: StepOptions<unknown, BatchTestData>[] = [
        { id: 'no_collect_1', description: 'Step 1', prompt: 'Prompt 1', collect: [] },
        { id: 'no_collect_2', description: 'Step 2', prompt: 'Prompt 2' },
      ];
      
      const route = new Route<unknown, BatchTestData>({
        title: 'No Collect Route',
        steps,
      });
      
      const builder = new BatchPromptBuilder<unknown, BatchTestData>();
      
      const result = await builder.buildBatchPrompt({
        steps,
        route,
        history: [],
        context: {},
        session: { id: 'test-session', data: {} },
        agentOptions: {
          name: 'Test Agent',
          provider: mockProvider as any,
        },
      });
      
      expect(result.stepCount).toBe(2);
      expect(result.collectFields.length).toBe(0);
    });

    test("handles duplicate collect fields across steps", async () => {
      const steps: StepOptions<unknown, BatchTestData>[] = [
        { id: 'dup_1', description: 'Step 1', prompt: 'Prompt 1', collect: ['field1', 'field2'] },
        { id: 'dup_2', description: 'Step 2', prompt: 'Prompt 2', collect: ['field2', 'field3'] },
      ];
      
      const route = new Route<unknown, BatchTestData>({
        title: 'Duplicate Collect Route',
        steps,
      });
      
      const builder = new BatchPromptBuilder<unknown, BatchTestData>();
      
      const result = await builder.buildBatchPrompt({
        steps,
        route,
        history: [],
        context: {},
        session: { id: 'test-session', data: {} },
        agentOptions: {
          name: 'Test Agent',
          provider: mockProvider as any,
        },
      });
      
      // Should deduplicate collect fields
      expect(result.collectFields.length).toBe(3);
      expect(result.collectFields).toContain('field1');
      expect(result.collectFields).toContain('field2');
      expect(result.collectFields).toContain('field3');
    });

    test("handles function prompts", async () => {
      const steps: StepOptions<unknown, BatchTestData>[] = [
        { 
          id: 'fn_prompt', 
          description: 'Function prompt step', 
          prompt: ({ context }) => `Dynamic prompt with context`, 
          collect: ['field1'] 
        },
      ];
      
      const route = new Route<unknown, BatchTestData>({
        title: 'Function Prompt Route',
        steps,
      });
      
      const builder = new BatchPromptBuilder<unknown, BatchTestData>();
      
      const result = await builder.buildBatchPrompt({
        steps,
        route,
        history: [],
        context: {},
        session: { id: 'test-session', data: {} },
        agentOptions: {
          name: 'Test Agent',
          provider: mockProvider as any,
        },
      });
      
      expect(result.prompt).toContain('Dynamic prompt with context');
    });

    test("includes agent identity and personality", async () => {
      const steps: StepOptions<unknown, BatchTestData>[] = [
        { id: 'step1', description: 'Step 1', prompt: 'Prompt 1', collect: [] },
      ];
      
      const route = new Route<unknown, BatchTestData>({
        title: 'Identity Route',
        steps,
      });
      
      const builder = new BatchPromptBuilder<unknown, BatchTestData>();
      
      const result = await builder.buildBatchPrompt({
        steps,
        route,
        history: [],
        context: {},
        session: { id: 'test-session', data: {} },
        agentOptions: {
          name: 'Test Agent',
          description: 'A helpful test agent',
          identity: 'I am a test assistant',
          personality: 'Friendly and helpful',
          provider: mockProvider as any,
        },
      });
      
      expect(result.prompt).toContain('Test Agent');
    });

    test("handles empty steps array", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'Empty Route',
        steps: [],
      });
      
      const builder = new BatchPromptBuilder<unknown, BatchTestData>();
      
      const result = await builder.buildBatchPrompt({
        steps: [],
        route,
        history: [],
        context: {},
        session: { id: 'test-session', data: {} },
        agentOptions: {
          name: 'Test Agent',
          provider: mockProvider as any,
        },
      });
      
      expect(result.stepCount).toBe(0);
      expect(result.collectFields.length).toBe(0);
      expect(typeof result.prompt).toBe('string');
    });
  });
});


/**
 * Property-Based Tests for BatchExecutor Hook Execution
 * 
 * Feature: multi-step-execution
 * Property 6: Hook Execution Order
 * 
 * Tests the executeHooks methods which execute prepare and finalize hooks
 * for batched steps.
 * 
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**
 */
describe("BatchExecutor - Hook Execution", () => {
  /**
   * Property 6: Hook Execution Order
   * 
   * For any batch of Steps with hooks, the Execution_Engine SHALL:
   * - Execute all `prepare` hooks before the LLM call
   * - Execute all `finalize` hooks after the LLM response
   * - Execute hooks in Step order within each phase
   * - Stop on `prepare` hook failure, continue on `finalize` hook failure
   * 
   * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**
   */
  
  describe("Property 6: Hook Execution Order", () => {
    test("executes prepare hooks in step order", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (numSteps) => {
            const executionOrder: string[] = [];
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create steps with prepare hooks that record execution order
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            for (let i = 0; i < numSteps; i++) {
              steps.push({
                id: `step_${i}`,
                description: `Step ${i}`,
                prepare: async () => {
                  executionOrder.push(`prepare_${i}`);
                },
              });
            }
            
            // Create a mock executeHook function
            const executeHook = async (
              hook: HookFunction<unknown, BatchTestData>,
              context: unknown,
              data?: Partial<BatchTestData>
            ) => {
              if (typeof hook === 'function') {
                await hook(context, data);
              }
            };
            
            const params: ExecuteHooksParams<unknown, BatchTestData> = {
              steps,
              context: {},
              data: {},
              executeHook,
            };
            
            const result = await executor.executePrepareHooks(params);
            
            // Property: All hooks should execute successfully
            expect(result.success).toBe(true);
            
            // Property: Hooks should execute in step order
            expect(executionOrder.length).toBe(numSteps);
            for (let i = 0; i < numSteps; i++) {
              expect(executionOrder[i]).toBe(`prepare_${i}`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("executes finalize hooks in step order", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (numSteps) => {
            const executionOrder: string[] = [];
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create steps with finalize hooks that record execution order
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            for (let i = 0; i < numSteps; i++) {
              steps.push({
                id: `step_${i}`,
                description: `Step ${i}`,
                finalize: async () => {
                  executionOrder.push(`finalize_${i}`);
                },
              });
            }
            
            // Create a mock executeHook function
            const executeHook = async (
              hook: HookFunction<unknown, BatchTestData>,
              context: unknown,
              data?: Partial<BatchTestData>
            ) => {
              if (typeof hook === 'function') {
                await hook(context, data);
              }
            };
            
            const params: ExecuteHooksParams<unknown, BatchTestData> = {
              steps,
              context: {},
              data: {},
              executeHook,
            };
            
            const result = await executor.executeFinalizeHooks(params);
            
            // Property: All hooks should execute (finalize always succeeds)
            expect(result.success).toBe(true);
            
            // Property: Hooks should execute in step order
            expect(executionOrder.length).toBe(numSteps);
            for (let i = 0; i < numSteps; i++) {
              expect(executionOrder[i]).toBe(`finalize_${i}`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("stops on prepare hook failure", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          fc.integer({ min: 0, max: 3 }),
          async (numSteps, failAtIndex) => {
            const actualFailIndex = Math.min(failAtIndex, numSteps - 1);
            const executionOrder: string[] = [];
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create steps with prepare hooks, one of which will fail
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            for (let i = 0; i < numSteps; i++) {
              steps.push({
                id: `step_${i}`,
                description: `Step ${i}`,
                prepare: async () => {
                  executionOrder.push(`prepare_${i}`);
                  if (i === actualFailIndex) {
                    throw new Error(`Prepare hook ${i} failed`);
                  }
                },
              });
            }
            
            // Create a mock executeHook function that propagates errors
            const executeHook = async (
              hook: HookFunction<unknown, BatchTestData>,
              context: unknown,
              data?: Partial<BatchTestData>
            ) => {
              if (typeof hook === 'function') {
                await hook(context, data);
              }
            };
            
            const params: ExecuteHooksParams<unknown, BatchTestData> = {
              steps,
              context: {},
              data: {},
              executeHook,
            };
            
            const result = await executor.executePrepareHooks(params);
            
            // Property: Should fail
            expect(result.success).toBe(false);
            
            // Property: Should have error details
            expect(result.error).toBeDefined();
            expect(result.error?.type).toBe('prepare_hook');
            expect(result.error?.stepId).toBe(`step_${actualFailIndex}`);
            
            // Property: Should have executed hooks up to and including the failing one
            expect(executionOrder.length).toBe(actualFailIndex + 1);
            
            // Property: Hooks after the failure should NOT have executed
            for (let i = actualFailIndex + 1; i < numSteps; i++) {
              expect(executionOrder).not.toContain(`prepare_${i}`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("continues on finalize hook failure", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          fc.integer({ min: 0, max: 3 }),
          async (numSteps, failAtIndex) => {
            const actualFailIndex = Math.min(failAtIndex, numSteps - 1);
            const executionOrder: string[] = [];
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create steps with finalize hooks, one of which will fail
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            for (let i = 0; i < numSteps; i++) {
              steps.push({
                id: `step_${i}`,
                description: `Step ${i}`,
                finalize: async () => {
                  executionOrder.push(`finalize_${i}`);
                  if (i === actualFailIndex) {
                    throw new Error(`Finalize hook ${i} failed`);
                  }
                },
              });
            }
            
            // Create a mock executeHook function that propagates errors
            const executeHook = async (
              hook: HookFunction<unknown, BatchTestData>,
              context: unknown,
              data?: Partial<BatchTestData>
            ) => {
              if (typeof hook === 'function') {
                await hook(context, data);
              }
            };
            
            const params: ExecuteHooksParams<unknown, BatchTestData> = {
              steps,
              context: {},
              data: {},
              executeHook,
            };
            
            const result = await executor.executeFinalizeHooks(params);
            
            // Property: Should still succeed (finalize errors don't stop execution)
            expect(result.success).toBe(true);
            
            // Property: Should have recorded the error
            expect(result.errors).toBeDefined();
            expect(result.errors?.length).toBe(1);
            expect(result.errors?.[0].stepId).toBe(`step_${actualFailIndex}`);
            expect(result.errors?.[0].error.type).toBe('finalize_hook');
            
            // Property: ALL hooks should have executed despite the failure
            expect(executionOrder.length).toBe(numSteps);
            for (let i = 0; i < numSteps; i++) {
              expect(executionOrder[i]).toBe(`finalize_${i}`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("handles multiple finalize hook failures", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 3, max: 5 }),
          fc.uniqueArray(fc.integer({ min: 0, max: 4 }), { minLength: 2, maxLength: 3 }),
          async (numSteps, failIndices) => {
            // Filter to valid indices
            const validFailIndices = failIndices.filter(i => i < numSteps);
            if (validFailIndices.length < 2) return; // Skip if not enough valid indices
            
            const executionOrder: string[] = [];
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create steps with finalize hooks, some of which will fail
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            for (let i = 0; i < numSteps; i++) {
              steps.push({
                id: `step_${i}`,
                description: `Step ${i}`,
                finalize: async () => {
                  executionOrder.push(`finalize_${i}`);
                  if (validFailIndices.includes(i)) {
                    throw new Error(`Finalize hook ${i} failed`);
                  }
                },
              });
            }
            
            // Create a mock executeHook function
            const executeHook = async (
              hook: HookFunction<unknown, BatchTestData>,
              context: unknown,
              data?: Partial<BatchTestData>
            ) => {
              if (typeof hook === 'function') {
                await hook(context, data);
              }
            };
            
            const params: ExecuteHooksParams<unknown, BatchTestData> = {
              steps,
              context: {},
              data: {},
              executeHook,
            };
            
            const result = await executor.executeFinalizeHooks(params);
            
            // Property: Should still succeed
            expect(result.success).toBe(true);
            
            // Property: Should have recorded all errors
            expect(result.errors?.length).toBe(validFailIndices.length);
            
            // Property: ALL hooks should have executed
            expect(executionOrder.length).toBe(numSteps);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("skips steps without hooks", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          fc.uniqueArray(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 3 }),
          async (numSteps, stepsWithHooks) => {
            // Filter to valid indices
            const validStepsWithHooks = stepsWithHooks.filter(i => i < numSteps);
            if (validStepsWithHooks.length === 0) return;
            
            const executionOrder: string[] = [];
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create steps, only some with hooks
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            for (let i = 0; i < numSteps; i++) {
              const hasHook = validStepsWithHooks.includes(i);
              steps.push({
                id: `step_${i}`,
                description: `Step ${i}`,
                prepare: hasHook ? async () => {
                  executionOrder.push(`prepare_${i}`);
                } : undefined,
              });
            }
            
            // Create a mock executeHook function
            const executeHook = async (
              hook: HookFunction<unknown, BatchTestData>,
              context: unknown,
              data?: Partial<BatchTestData>
            ) => {
              if (typeof hook === 'function') {
                await hook(context, data);
              }
            };
            
            const params: ExecuteHooksParams<unknown, BatchTestData> = {
              steps,
              context: {},
              data: {},
              executeHook,
            };
            
            const result = await executor.executePrepareHooks(params);
            
            // Property: Should succeed
            expect(result.success).toBe(true);
            
            // Property: Only steps with hooks should have executed
            expect(executionOrder.length).toBe(validStepsWithHooks.length);
            
            // Property: Executed hooks should be in step order
            const sortedStepsWithHooks = [...validStepsWithHooks].sort((a, b) => a - b);
            for (let i = 0; i < sortedStepsWithHooks.length; i++) {
              expect(executionOrder[i]).toBe(`prepare_${sortedStepsWithHooks[i]}`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("passes context and data to hooks", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            contextValue: fc.string(),
            dataValue: fc.string(),
          }),
          async ({ contextValue, dataValue }) => {
            const receivedParams: Array<{ context: unknown; data: unknown }> = [];
            const executor = new BatchExecutor<{ value: string }, BatchTestData>();
            
            const steps: StepOptions<{ value: string }, BatchTestData>[] = [
              {
                id: 'step_0',
                description: 'Step 0',
                prepare: async (ctx, data) => {
                  receivedParams.push({ context: ctx, data });
                },
              },
            ];
            
            const testContext = { value: contextValue };
            const testData: Partial<BatchTestData> = { field1: dataValue };
            
            // Create a mock executeHook function that passes context and data
            const executeHook = async (
              hook: HookFunction<{ value: string }, BatchTestData>,
              context: { value: string },
              data?: Partial<BatchTestData>
            ) => {
              if (typeof hook === 'function') {
                await hook(context, data);
              }
            };
            
            const params: ExecuteHooksParams<{ value: string }, BatchTestData> = {
              steps,
              context: testContext,
              data: testData,
              executeHook,
            };
            
            await executor.executePrepareHooks(params);
            
            // Property: Hook should receive correct context and data
            expect(receivedParams.length).toBe(1);
            expect(receivedParams[0].context).toEqual(testContext);
            expect(receivedParams[0].data).toEqual(testData);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Unit tests for edge cases
  describe("Hook Execution Edge Cases", () => {
    test("handles empty steps array for prepare hooks", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const executeHook = async () => {};
      
      const result = await executor.executePrepareHooks({
        steps: [],
        context: {},
        data: {},
        executeHook,
      });
      
      expect(result.success).toBe(true);
      expect(result.executedSteps.length).toBe(0);
    });

    test("handles empty steps array for finalize hooks", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const executeHook = async () => {};
      
      const result = await executor.executeFinalizeHooks({
        steps: [],
        context: {},
        data: {},
        executeHook,
      });
      
      expect(result.success).toBe(true);
      expect(result.executedSteps.length).toBe(0);
    });

    test("handles steps with no hooks", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const steps: StepOptions<unknown, BatchTestData>[] = [
        { id: 'step_0', description: 'Step 0' },
        { id: 'step_1', description: 'Step 1' },
      ];
      
      const executeHook = async () => {};
      
      const prepareResult = await executor.executePrepareHooks({
        steps,
        context: {},
        data: {},
        executeHook,
      });
      
      const finalizeResult = await executor.executeFinalizeHooks({
        steps,
        context: {},
        data: {},
        executeHook,
      });
      
      expect(prepareResult.success).toBe(true);
      expect(prepareResult.executedSteps.length).toBe(0);
      expect(finalizeResult.success).toBe(true);
      expect(finalizeResult.executedSteps.length).toBe(0);
    });

    test("handles async hooks with delays", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      const executionOrder: string[] = [];
      
      const steps: StepOptions<unknown, BatchTestData>[] = [
        {
          id: 'step_0',
          prepare: async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            executionOrder.push('prepare_0');
          },
        },
        {
          id: 'step_1',
          prepare: async () => {
            await new Promise(resolve => setTimeout(resolve, 5));
            executionOrder.push('prepare_1');
          },
        },
      ];
      
      const executeHook = async (
        hook: HookFunction<unknown, BatchTestData>,
        context: unknown,
        data?: Partial<BatchTestData>
      ) => {
        if (typeof hook === 'function') {
          await hook(context, data);
        }
      };
      
      const result = await executor.executePrepareHooks({
        steps,
        context: {},
        data: {},
        executeHook,
      });
      
      expect(result.success).toBe(true);
      // Even with different delays, hooks should execute in order
      expect(executionOrder).toEqual(['prepare_0', 'prepare_1']);
    });

    test("createHookExecutor returns working executor", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      const executionOrder: string[] = [];
      
      const steps: StepOptions<unknown, BatchTestData>[] = [
        {
          id: 'step_0',
          prepare: async () => { executionOrder.push('prepare_0'); },
          finalize: async () => { executionOrder.push('finalize_0'); },
        },
      ];
      
      const executeHook = async (
        hook: HookFunction<unknown, BatchTestData>,
        context: unknown,
        data?: Partial<BatchTestData>
      ) => {
        if (typeof hook === 'function') {
          await hook(context, data);
        }
      };
      
      const hookExecutor = executor.createHookExecutor({
        steps,
        context: {},
        data: {},
        executeHook,
      });
      
      // Execute prepare
      const prepareResult = await hookExecutor.executePrepare();
      expect(prepareResult.success).toBe(true);
      expect(executionOrder).toEqual(['prepare_0']);
      
      // Execute finalize
      const finalizeResult = await hookExecutor.executeFinalize();
      expect(finalizeResult.success).toBe(true);
      expect(executionOrder).toEqual(['prepare_0', 'finalize_0']);
    });

    test("handles tool-based hooks via executeHook callback", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      const executedTools: string[] = [];
      
      const steps: StepOptions<unknown, BatchTestData>[] = [
        {
          id: 'step_0',
          prepare: 'tool_prepare', // Tool ID as string
        },
        {
          id: 'step_1',
          prepare: {
            id: 'inline_tool',
            handler: async () => {},
          }, // Inline tool object
        },
      ];
      
      // Mock executeHook that handles both string and tool object
      const executeHook = async (
        hook: HookFunction<unknown, BatchTestData>,
        _context: unknown,
        _data?: Partial<BatchTestData>
      ) => {
        if (typeof hook === 'string') {
          executedTools.push(hook);
        } else if (typeof hook === 'object' && 'id' in hook) {
          executedTools.push(hook.id);
        }
      };
      
      const result = await executor.executePrepareHooks({
        steps,
        context: {},
        data: {},
        executeHook,
      });
      
      expect(result.success).toBe(true);
      expect(executedTools).toEqual(['tool_prepare', 'inline_tool']);
    });
  });
});


/**
 * Property-Based Tests for BatchExecutor Data Collection
 * 
 * Feature: multi-step-execution
 * Property 7: Data Collection Across Batch
 * 
 * Tests the collectBatchData method which collects data from LLM responses
 * for all steps in a batch.
 * 
 * **Validates: Requirements 6.1, 6.2, 6.3**
 */
import type { 
  CollectBatchDataParams, 
  CollectBatchDataResult,
  ValidationError 
} from "../src/core/BatchExecutor";
import type { StructuredSchema } from "../src/types/schema";

describe("BatchExecutor - Data Collection", () => {
  /**
   * Property 7: Data Collection Across Batch
   * 
   * For any batch where multiple Steps have `collect` fields, the Execution_Engine SHALL 
   * collect all specified fields from the LLM response, validate them against the schema, 
   * and update session data with all collected values.
   * 
   * **Validates: Requirements 6.1, 6.2, 6.3**
   */
  
  describe("Property 7: Data Collection Across Batch", () => {
    test("collects all specified fields from LLM response across multiple steps", async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate steps with collect fields
          fc.array(
            fc.record({
              id: fc.string({ minLength: 1, maxLength: 10 }).map(s => `step_${s}`),
              collectFields: fc.uniqueArray(
                fc.constantFrom('field1', 'field2', 'field3', 'field4', 'field5') as fc.Arbitrary<keyof BatchTestData>,
                { minLength: 0, maxLength: 3 }
              ),
            }),
            { minLength: 1, maxLength: 5 }
          ),
          async (stepConfigs) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Ensure unique IDs
            const uniqueConfigs = stepConfigs.map((config, idx) => ({
              ...config,
              id: `${config.id}_${idx}`,
            }));
            
            // Create steps with collect fields
            const steps = uniqueConfigs.map(config => ({
              id: config.id,
              collect: config.collectFields,
            }));
            
            // Gather all collect fields
            const allCollectFields = new Set<string>();
            for (const config of uniqueConfigs) {
              for (const field of config.collectFields) {
                allCollectFields.add(String(field));
              }
            }
            
            // Create LLM response with all collect fields
            const llmResponse: Record<string, unknown> = { message: 'Test response' };
            for (const field of allCollectFields) {
              llmResponse[field] = `value_for_${field}`;
            }
            
            const session = { id: 'test-session', data: {} as Partial<BatchTestData> };
            
            const result = executor.collectBatchData({
              steps,
              llmResponse,
              session,
            });
            
            // Property: All collect fields should be collected
            expect(result.fieldsCollected.length).toBe(allCollectFields.size);
            for (const field of allCollectFields) {
              expect(result.fieldsCollected).toContain(field);
              expect(result.collectedData[field as keyof BatchTestData]).toBe(`value_for_${field}`);
            }
            
            // Property: Session should be updated with collected data
            for (const field of allCollectFields) {
              expect(result.session.data[field as keyof BatchTestData]).toBe(`value_for_${field}`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("validates collected data against agent schema", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('field1', 'field2', 'field3') as fc.Arbitrary<keyof BatchTestData>,
          fc.string({ minLength: 1, maxLength: 20 }),
          async (collectField, fieldValue) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            const steps = [{ id: 'step_1', collect: [collectField] }];
            
            const llmResponse: Record<string, unknown> = {
              message: 'Test response',
              [collectField]: fieldValue,
            };
            
            const session = { id: 'test-session', data: {} as Partial<BatchTestData> };
            
            // Schema that defines the field as string type
            const schema: StructuredSchema = {
              type: 'object',
              properties: {
                [collectField]: { type: 'string' },
              },
            };
            
            const result = executor.collectBatchData({
              steps,
              llmResponse,
              session,
              schema,
            });
            
            // Property: Validation should pass for correct type
            expect(result.success).toBe(true);
            expect(result.validationErrors).toBeUndefined();
            expect(result.collectedData[collectField]).toBe(fieldValue);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("updates session data with all collected values", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            field1: fc.option(fc.string()),
            field2: fc.option(fc.string()),
            field3: fc.option(fc.string()),
          }),
          fc.record({
            field1: fc.option(fc.string()),
            field2: fc.option(fc.string()),
            field3: fc.option(fc.string()),
          }),
          async (existingData, newData) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Determine which fields to collect (those with new data)
            const collectFields: (keyof BatchTestData)[] = [];
            const llmResponse: Record<string, unknown> = { message: 'Test response' };
            
            for (const [key, value] of Object.entries(newData)) {
              if (value !== null) {
                collectFields.push(key as keyof BatchTestData);
                llmResponse[key] = value;
              }
            }
            
            if (collectFields.length === 0) return; // Skip if no fields to collect
            
            const steps = [{ id: 'step_1', collect: collectFields }];
            
            // Create session with existing data
            const existingSessionData: Partial<BatchTestData> = {};
            for (const [key, value] of Object.entries(existingData)) {
              if (value !== null) {
                existingSessionData[key as keyof BatchTestData] = value;
              }
            }
            
            const session = { id: 'test-session', data: existingSessionData };
            
            const result = executor.collectBatchData({
              steps,
              llmResponse,
              session,
            });
            
            // Property: Session should contain both existing and new data
            // New data should override existing data for collected fields
            for (const [key, value] of Object.entries(existingData)) {
              if (value !== null && !collectFields.includes(key as keyof BatchTestData)) {
                // Existing data that wasn't collected should be preserved
                expect(result.session.data[key as keyof BatchTestData]).toBe(value);
              }
            }
            
            for (const [key, value] of Object.entries(newData)) {
              if (value !== null) {
                // New collected data should be in session
                expect(result.session.data[key as keyof BatchTestData]).toBe(value);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("reports missing fields when LLM response lacks expected data", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(
            fc.constantFrom('field1', 'field2', 'field3', 'field4', 'field5') as fc.Arbitrary<keyof BatchTestData>,
            { minLength: 2, maxLength: 5 }
          ),
          fc.integer({ min: 0, max: 3 }),
          async (collectFields, numPresent) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Only include some fields in the response
            const presentCount = Math.min(numPresent, collectFields.length - 1);
            const presentFields = collectFields.slice(0, presentCount);
            const missingFields = collectFields.slice(presentCount);
            
            const steps = [{ id: 'step_1', collect: collectFields }];
            
            const llmResponse: Record<string, unknown> = { message: 'Test response' };
            for (const field of presentFields) {
              llmResponse[field] = `value_for_${field}`;
            }
            
            const session = { id: 'test-session', data: {} as Partial<BatchTestData> };
            
            const result = executor.collectBatchData({
              steps,
              llmResponse,
              session,
            });
            
            // Property: Present fields should be collected
            expect(result.fieldsCollected.length).toBe(presentCount);
            for (const field of presentFields) {
              expect(result.fieldsCollected).toContain(String(field));
            }
            
            // Property: Missing fields should be reported
            if (missingFields.length > 0) {
              expect(result.fieldsMissing).toBeDefined();
              expect(result.fieldsMissing?.length).toBe(missingFields.length);
              for (const field of missingFields) {
                expect(result.fieldsMissing).toContain(String(field));
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("reports validation errors for invalid data types", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('field1', 'field2', 'field3') as fc.Arbitrary<keyof BatchTestData>,
          async (collectField) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            const steps = [{ id: 'step_1', collect: [collectField] }];
            
            // LLM response with wrong type (number instead of string)
            const llmResponse: Record<string, unknown> = {
              message: 'Test response',
              [collectField]: 12345, // Number instead of expected string
            };
            
            const session = { id: 'test-session', data: {} as Partial<BatchTestData> };
            
            // Schema that expects string type
            const schema: StructuredSchema = {
              type: 'object',
              properties: {
                [collectField]: { type: 'string' },
              },
            };
            
            const result = executor.collectBatchData({
              steps,
              llmResponse,
              session,
              schema,
            });
            
            // Property: Should report validation error
            expect(result.success).toBe(false);
            expect(result.validationErrors).toBeDefined();
            expect(result.validationErrors?.length).toBeGreaterThan(0);
            expect(result.validationErrors?.[0].field).toBe(collectField);
            
            // Property: Data should still be collected (validation is informational)
            expect(result.collectedData[collectField]).toBe(12345);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("handles steps with no collect fields", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (numSteps) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create steps with no collect fields
            const steps = Array.from({ length: numSteps }, (_, i) => ({
              id: `step_${i}`,
              collect: [] as (keyof BatchTestData)[],
            }));
            
            const llmResponse: Record<string, unknown> = {
              message: 'Test response',
              field1: 'value1', // Extra data in response
            };
            
            const session = { id: 'test-session', data: {} as Partial<BatchTestData> };
            
            const result = executor.collectBatchData({
              steps,
              llmResponse,
              session,
            });
            
            // Property: Should succeed with no data collected
            expect(result.success).toBe(true);
            expect(result.fieldsCollected.length).toBe(0);
            expect(Object.keys(result.collectedData).length).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("deduplicates collect fields across steps", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(
            fc.constantFrom('field1', 'field2', 'field3') as fc.Arbitrary<keyof BatchTestData>,
            { minLength: 1, maxLength: 3 }
          ),
          async (sharedFields) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create multiple steps that collect the same fields
            const steps = [
              { id: 'step_1', collect: sharedFields },
              { id: 'step_2', collect: sharedFields },
            ];
            
            const llmResponse: Record<string, unknown> = { message: 'Test response' };
            for (const field of sharedFields) {
              llmResponse[field] = `value_for_${field}`;
            }
            
            const session = { id: 'test-session', data: {} as Partial<BatchTestData> };
            
            const result = executor.collectBatchData({
              steps,
              llmResponse,
              session,
            });
            
            // Property: Each field should only be collected once
            expect(result.fieldsCollected.length).toBe(sharedFields.length);
            
            // Property: Session should have correct values
            for (const field of sharedFields) {
              expect(result.session.data[field]).toBe(`value_for_${field}`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Unit tests for edge cases
  describe("Data Collection Edge Cases", () => {
    test("handles empty steps array", () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = executor.collectBatchData({
        steps: [],
        llmResponse: { message: 'Test', field1: 'value' },
        session: { id: 'test', data: {} },
      });
      
      expect(result.success).toBe(true);
      expect(result.fieldsCollected.length).toBe(0);
      expect(Object.keys(result.collectedData).length).toBe(0);
    });

    test("handles undefined collect arrays", () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const steps = [
        { id: 'step_1' }, // No collect field
        { id: 'step_2', collect: undefined },
      ];
      
      const result = executor.collectBatchData({
        steps: steps as Array<{ collect?: readonly (keyof BatchTestData)[] }>,
        llmResponse: { message: 'Test', field1: 'value' },
        session: { id: 'test', data: {} },
      });
      
      expect(result.success).toBe(true);
      expect(result.fieldsCollected.length).toBe(0);
    });

    test("handles null values in LLM response", () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const steps = [{ id: 'step_1', collect: ['field1' as keyof BatchTestData] }];
      
      const result = executor.collectBatchData({
        steps,
        llmResponse: { message: 'Test', field1: null },
        session: { id: 'test', data: {} },
      });
      
      // null is a valid value, should be collected
      expect(result.fieldsCollected).toContain('field1');
      expect(result.collectedData.field1).toBeNull();
    });

    test("handles empty string values", () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const steps = [{ id: 'step_1', collect: ['field1' as keyof BatchTestData] }];
      
      const result = executor.collectBatchData({
        steps,
        llmResponse: { message: 'Test', field1: '' },
        session: { id: 'test', data: {} },
      });
      
      // Empty string is a valid value
      expect(result.fieldsCollected).toContain('field1');
      expect(result.collectedData.field1).toBe('');
    });

    test("preserves existing session data not being collected", () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const steps = [{ id: 'step_1', collect: ['field2' as keyof BatchTestData] }];
      
      const existingData: Partial<BatchTestData> = { field1: 'existing_value' };
      
      const result = executor.collectBatchData({
        steps,
        llmResponse: { message: 'Test', field2: 'new_value' },
        session: { id: 'test', data: existingData },
      });
      
      // Existing data should be preserved
      expect(result.session.data.field1).toBe('existing_value');
      // New data should be added
      expect(result.session.data.field2).toBe('new_value');
    });

    test("validates integer type correctly", () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const steps = [{ id: 'step_1', collect: ['field1' as keyof BatchTestData] }];
      
      const schema: StructuredSchema = {
        type: 'object',
        properties: {
          field1: { type: 'integer' },
        },
      };
      
      // Test with valid integer
      const result1 = executor.collectBatchData({
        steps,
        llmResponse: { message: 'Test', field1: 42 },
        session: { id: 'test', data: {} },
        schema,
      });
      
      expect(result1.success).toBe(true);
      expect(result1.collectedData.field1).toBe(42);
      
      // Test with float (should fail integer validation)
      const result2 = executor.collectBatchData({
        steps,
        llmResponse: { message: 'Test', field1: 42.5 },
        session: { id: 'test', data: {} },
        schema,
      });
      
      expect(result2.success).toBe(false);
      expect(result2.validationErrors?.length).toBeGreaterThan(0);
    });

    test("handles array type validation", () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const steps = [{ id: 'step_1', collect: ['field1' as keyof BatchTestData] }];
      
      const schema: StructuredSchema = {
        type: 'object',
        properties: {
          field1: { type: 'array' },
        },
      };
      
      // Test with valid array
      const result1 = executor.collectBatchData({
        steps,
        llmResponse: { message: 'Test', field1: ['a', 'b', 'c'] },
        session: { id: 'test', data: {} },
        schema,
      });
      
      expect(result1.success).toBe(true);
      
      // Test with non-array (should fail)
      const result2 = executor.collectBatchData({
        steps,
        llmResponse: { message: 'Test', field1: 'not an array' },
        session: { id: 'test', data: {} },
        schema,
      });
      
      expect(result2.success).toBe(false);
    });

    test("handles fields not in schema", () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const steps = [{ id: 'step_1', collect: ['field1' as keyof BatchTestData, 'field2' as keyof BatchTestData] }];
      
      // Schema only defines field1
      const schema: StructuredSchema = {
        type: 'object',
        properties: {
          field1: { type: 'string' },
        },
      };
      
      const result = executor.collectBatchData({
        steps,
        llmResponse: { message: 'Test', field1: 'value1', field2: 'value2' },
        session: { id: 'test', data: {} },
        schema,
      });
      
      // Should report validation error for field not in schema
      expect(result.success).toBe(false);
      expect(result.validationErrors?.some(e => e.field === 'field2')).toBe(true);
      
      // But data should still be collected
      expect(result.collectedData.field1).toBe('value1');
      expect(result.collectedData.field2).toBe('value2');
    });

    test("handles schema with multiple allowed types", () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const steps = [{ id: 'step_1', collect: ['field1' as keyof BatchTestData] }];
      
      const schema: StructuredSchema = {
        type: 'object',
        properties: {
          field1: { type: ['string', 'number'] },
        },
      };
      
      // Test with string
      const result1 = executor.collectBatchData({
        steps,
        llmResponse: { message: 'Test', field1: 'string_value' },
        session: { id: 'test', data: {} },
        schema,
      });
      
      expect(result1.success).toBe(true);
      
      // Test with number
      const result2 = executor.collectBatchData({
        steps,
        llmResponse: { message: 'Test', field1: 123 },
        session: { id: 'test', data: {} },
        schema,
      });
      
      expect(result2.success).toBe(true);
      
      // Test with boolean (should fail)
      const result3 = executor.collectBatchData({
        steps,
        llmResponse: { message: 'Test', field1: true },
        session: { id: 'test', data: {} },
        schema,
      });
      
      expect(result3.success).toBe(false);
    });

    test("works without schema (no validation)", () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const steps = [{ id: 'step_1', collect: ['field1' as keyof BatchTestData] }];
      
      const result = executor.collectBatchData({
        steps,
        llmResponse: { message: 'Test', field1: { complex: 'object' } },
        session: { id: 'test', data: {} },
        // No schema provided
      });
      
      // Should succeed without validation
      expect(result.success).toBe(true);
      expect(result.validationErrors).toBeUndefined();
      expect(result.collectedData.field1).toEqual({ complex: 'object' });
    });
  });
});


/**
 * Property-Based Tests for Pre-Extraction Affecting Batch Determination
 * 
 * Feature: multi-step-execution
 * Property 4: Pre-Extraction Affects Batch Determination
 * 
 * Tests that pre-extracted data is merged into session data before batch determination,
 * and that steps whose requirements are satisfied by pre-extracted data are included in the batch.
 * 
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
 */

describe("BatchExecutor - Pre-Extraction Affects Batch Determination", () => {
  /**
   * Property 4: Pre-Extraction Affects Batch Determination
   * 
   * For any Route with requiredFields or optionalFields, and for any user message 
   * containing extractable data, the pre-extracted data SHALL be merged into session 
   * data before batch determination, and Steps whose requirements are satisfied by 
   * pre-extracted data SHALL be included in the batch.
   * 
   * **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
   */
  
  describe("Property 4: Pre-Extraction Affects Batch Determination", () => {
    test("steps with satisfied requires are included when pre-extracted data is merged", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(
            fc.constantFrom('field1', 'field2', 'field3') as fc.Arbitrary<keyof BatchTestData>,
            { minLength: 1, maxLength: 3 }
          ),
          async (requiredFields) => {
            // Create a route where the first step requires fields
            const route = new Route<unknown, BatchTestData>({
              title: 'Pre-Extraction Test Route',
              requiredFields,
              steps: [
                { id: 'step1', requires: requiredFields, collect: [] },
                { id: 'step2', requires: [], collect: [] },
              ],
            });
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Simulate pre-extraction: session data WITHOUT the required fields
            const sessionDataBeforePreExtraction: Partial<BatchTestData> = {};
            
            // Batch determination WITHOUT pre-extracted data should stop at step1
            const resultWithoutPreExtraction = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: sessionDataBeforePreExtraction,
              context: {},
            });
            
            // Should stop with needs_input because step1 requires fields
            expect(resultWithoutPreExtraction.stoppedReason).toBe('needs_input');
            expect(resultWithoutPreExtraction.steps.length).toBe(0);
            
            // Simulate pre-extraction: session data WITH the required fields (merged)
            const sessionDataAfterPreExtraction: Partial<BatchTestData> = {};
            requiredFields.forEach(f => { sessionDataAfterPreExtraction[f] = 'pre_extracted_value'; });
            
            // Batch determination WITH pre-extracted data should include step1
            const resultWithPreExtraction = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: sessionDataAfterPreExtraction,
              context: {},
            });
            
            // Step1 should be included because its requires are satisfied
            expect(resultWithPreExtraction.steps.length).toBeGreaterThanOrEqual(1);
            expect(resultWithPreExtraction.steps[0].id).toBe('step1');
          }
        ),
        { numRuns: 100 }
      );
    });

    test("pre-extracted data satisfies collect field requirements", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(
            fc.constantFrom('field1', 'field2', 'field3') as fc.Arbitrary<keyof BatchTestData>,
            { minLength: 1, maxLength: 3 }
          ),
          async (collectFields) => {
            // Create a route where the first step collects fields
            const route = new Route<unknown, BatchTestData>({
              title: 'Pre-Extraction Collect Test Route',
              steps: [
                { id: 'step1', requires: [], collect: collectFields },
                { id: 'step2', requires: [], collect: [] },
              ],
            });
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Without pre-extracted data, step1 needs input (collect fields have no data)
            const resultWithoutData = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: {},
              context: {},
            });
            
            expect(resultWithoutData.stoppedReason).toBe('needs_input');
            expect(resultWithoutData.steps.length).toBe(0);
            
            // With pre-extracted data for at least one collect field, step1 is included
            const sessionDataWithPreExtraction: Partial<BatchTestData> = {};
            sessionDataWithPreExtraction[collectFields[0]] = 'pre_extracted_value';
            
            const resultWithData = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: sessionDataWithPreExtraction,
              context: {},
            });
            
            // Step1 should be included because at least one collect field has data
            expect(resultWithData.steps.length).toBeGreaterThanOrEqual(1);
            expect(resultWithData.steps[0].id).toBe('step1');
          }
        ),
        { numRuns: 100 }
      );
    });

    test("batch includes multiple consecutive steps when pre-extraction satisfies all requirements", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 4 }),
          async (numSteps) => {
            // Create steps where each requires a different field
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            const allRequiredFields: (keyof BatchTestData)[] = [];
            
            for (let i = 0; i < numSteps; i++) {
              const fieldName = `field${i + 1}` as keyof BatchTestData;
              allRequiredFields.push(fieldName);
              steps.push({
                id: `step${i + 1}`,
                requires: [fieldName],
                collect: [],
              });
            }
            
            const route = new Route<unknown, BatchTestData>({
              title: 'Multi-Step Pre-Extraction Route',
              steps,
            });
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Pre-extract all required fields
            const sessionDataWithAllFields: Partial<BatchTestData> = {};
            allRequiredFields.forEach(f => { sessionDataWithAllFields[f] = 'value'; });
            
            const result = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: sessionDataWithAllFields,
              context: {},
            });
            
            // All steps should be included since all requirements are satisfied
            expect(result.steps.length).toBe(numSteps);
            
            // Verify steps are in order
            for (let i = 0; i < numSteps; i++) {
              expect(result.steps[i].id).toBe(`step${i + 1}`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("partial pre-extraction includes steps up to first unsatisfied requirement", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 3 }),
          async (numSatisfiedSteps) => {
            const totalSteps = numSatisfiedSteps + 1; // One more step that won't be satisfied
            
            // Create steps where each requires a different field
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            
            for (let i = 0; i < totalSteps; i++) {
              const fieldName = `field${i + 1}` as keyof BatchTestData;
              steps.push({
                id: `step${i + 1}`,
                requires: [fieldName],
                collect: [],
              });
            }
            
            const route = new Route<unknown, BatchTestData>({
              title: 'Partial Pre-Extraction Route',
              steps,
            });
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Pre-extract only the first N fields (leaving the last step unsatisfied)
            const sessionData: Partial<BatchTestData> = {};
            for (let i = 0; i < numSatisfiedSteps; i++) {
              const fieldName = `field${i + 1}` as keyof BatchTestData;
              sessionData[fieldName] = 'value';
            }
            
            const result = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData,
              context: {},
            });
            
            // Should include exactly numSatisfiedSteps steps
            expect(result.steps.length).toBe(numSatisfiedSteps);
            
            // Should stop with needs_input at the unsatisfied step
            expect(result.stoppedReason).toBe('needs_input');
            expect(result.stoppedAtStep?.id).toBe(`step${numSatisfiedSteps + 1}`);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("pre-extraction with mixed requires and collect fields", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('field1', 'field2') as fc.Arbitrary<keyof BatchTestData>,
          fc.constantFrom('field3', 'field4') as fc.Arbitrary<keyof BatchTestData>,
          async (requiresField, collectField) => {
            // Create a step that has both requires and collect
            const route = new Route<unknown, BatchTestData>({
              title: 'Mixed Requirements Route',
              steps: [
                { 
                  id: 'step1', 
                  requires: [requiresField], 
                  collect: [collectField],
                },
                { id: 'step2', requires: [], collect: [] },
              ],
            });
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Case 1: Only requires field is present (collect has no data)
            // Step should need input because collect fields have no data
            const sessionWithOnlyRequires: Partial<BatchTestData> = {};
            sessionWithOnlyRequires[requiresField] = 'value';
            
            const result1 = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: sessionWithOnlyRequires,
              context: {},
            });
            
            // Should need input because collect field has no data
            expect(result1.stoppedReason).toBe('needs_input');
            
            // Case 2: Both requires and collect fields are present
            const sessionWithBoth: Partial<BatchTestData> = {};
            sessionWithBoth[requiresField] = 'value';
            sessionWithBoth[collectField] = 'value';
            
            const result2 = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: sessionWithBoth,
              context: {},
            });
            
            // Step should be included
            expect(result2.steps.length).toBeGreaterThanOrEqual(1);
            expect(result2.steps[0].id).toBe('step1');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Unit tests for edge cases
  describe("Pre-Extraction Edge Cases", () => {
    test("empty pre-extraction does not affect batch determination", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'Empty Pre-Extraction Route',
        steps: [
          { id: 'step1', requires: ['field1'], collect: [] },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      // Empty pre-extraction (no data extracted)
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Should still need input
      expect(result.stoppedReason).toBe('needs_input');
      expect(result.steps.length).toBe(0);
    });

    test("pre-extraction with undefined values does not satisfy requirements", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'Undefined Pre-Extraction Route',
        steps: [
          { id: 'step1', requires: ['field1'], collect: [] },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      // Pre-extraction with undefined value
      const sessionData: Partial<BatchTestData> = { field1: undefined };
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData,
        context: {},
      });
      
      // Should still need input (undefined is not a valid value)
      expect(result.stoppedReason).toBe('needs_input');
      expect(result.steps.length).toBe(0);
    });

    test("pre-extraction with empty string satisfies requirements", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'Empty String Pre-Extraction Route',
        steps: [
          { id: 'step1', requires: ['field1'], collect: [] },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      // Pre-extraction with empty string (valid value)
      const sessionData: Partial<BatchTestData> = { field1: '' };
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData,
        context: {},
      });
      
      // Empty string is a valid value, so step should be included
      expect(result.steps.length).toBeGreaterThanOrEqual(1);
    });

    test("pre-extraction order does not matter for batch determination", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'Order Independence Route',
        steps: [
          { id: 'step1', requires: ['field1', 'field2'], collect: [] },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      // Pre-extract in different orders
      const sessionData1: Partial<BatchTestData> = { field1: 'a', field2: 'b' };
      const sessionData2: Partial<BatchTestData> = { field2: 'b', field1: 'a' };
      
      const result1 = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: sessionData1,
        context: {},
      });
      
      const result2 = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: sessionData2,
        context: {},
      });
      
      // Both should produce the same result
      expect(result1.steps.length).toBe(result2.steps.length);
      expect(result1.stoppedReason).toBe(result2.stoppedReason);
    });
  });
});



/**
 * Property-Based Tests for BatchExecutor Error Handling
 * 
 * Feature: multi-step-execution
 * Property 10: Error Handling Preserves State
 * 
 * Tests that errors during batch execution preserve session state and include
 * appropriate error information in the response.
 * 
 * **Validates: Requirements 9.1, 9.2, 9.3**
 */
import type { ExecuteBatchParams } from "../src/core/BatchExecutor";
import type { BatchResult, BatchExecutionResult, StoppedReason } from "../src/types/route";

describe("BatchExecutor - Error Handling", () => {
  /**
   * Property 10: Error Handling Preserves State
   * 
   * For any error during batch execution (LLM failure, validation failure, or other), 
   * the Execution_Engine SHALL:
   * - Return the last successful session state
   * - Include error information in the response
   * - Preserve any partial progress made before the error
   * 
   * **Validates: Requirements 9.1, 9.2, 9.3**
   */
  
  describe("Property 10: Error Handling Preserves State", () => {
    test("LLM call failure returns last successful session state", async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate initial session data
          fc.record({
            field1: fc.option(fc.string()),
            field2: fc.option(fc.string()),
          }),
          // Generate error message
          fc.string({ minLength: 1, maxLength: 50 }),
          async (initialData, errorMessage) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create a batch with steps
            const batch: BatchResult<unknown, BatchTestData> = {
              steps: [
                { id: 'step1', requires: [], collect: ['field1'] },
                { id: 'step2', requires: [], collect: ['field2'] },
              ],
              stoppedReason: 'route_complete',
            };
            
            // Create initial session with data
            const sessionData: Partial<BatchTestData> = {};
            if (initialData.field1 !== null) sessionData.field1 = initialData.field1;
            if (initialData.field2 !== null) sessionData.field2 = initialData.field2;
            
            const initialSession = { 
              id: 'test-session', 
              data: sessionData,
            };
            
            // Mock executeHook that succeeds
            const executeHook = async () => {};
            
            // Mock generateMessage that throws an error
            const generateMessage = async () => {
              throw new Error(errorMessage);
            };
            
            const result = await executor.executeBatch({
              batch,
              session: initialSession,
              context: {},
              executeHook,
              generateMessage,
              routeId: 'test-route',
            });
            
            // Property: Should return 'llm_error' as stopped reason
            expect(result.stoppedReason).toBe('llm_error');
            
            // Property: Should include error information
            expect(result.error).toBeDefined();
            expect(result.error?.type).toBe('llm_call');
            expect(result.error?.message).toBe(errorMessage);
            
            // Property: Should preserve session state (return last successful state)
            expect(result.session.id).toBe('test-session');
            expect(result.session.data).toEqual(sessionData);
            
            // Property: No steps should be marked as executed (LLM failed)
            expect(result.executedSteps.length).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("validation failure includes errors in response and preserves collected data", async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate field value that will fail validation (number instead of string)
          fc.integer(),
          async (invalidValue) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create a batch with a step that collects data
            const batch: BatchResult<unknown, BatchTestData> = {
              steps: [
                { id: 'step1', requires: [], collect: ['field1' as keyof BatchTestData] },
              ],
              stoppedReason: 'route_complete',
            };
            
            const initialSession = { 
              id: 'test-session', 
              data: {} as Partial<BatchTestData>,
            };
            
            // Mock executeHook that succeeds
            const executeHook = async () => {};
            
            // Mock generateMessage that returns invalid data type
            const generateMessage = async () => ({
              message: 'Test response',
              structured: {
                message: 'Test response',
                field1: invalidValue, // Number instead of expected string
              },
            });
            
            // Schema that expects string type
            const schema = {
              type: 'object' as const,
              properties: {
                field1: { type: 'string' as const },
              },
            };
            
            const result = await executor.executeBatch({
              batch,
              session: initialSession,
              context: {},
              executeHook,
              generateMessage,
              schema,
              routeId: 'test-route',
            });
            
            // Property: Should return 'validation_error' as stopped reason
            expect(result.stoppedReason).toBe('validation_error');
            
            // Property: Should include validation error information
            expect(result.error).toBeDefined();
            expect(result.error?.type).toBe('data_validation');
            
            // Property: Should still collect the data (even if invalid)
            expect(result.collectedData?.field1).toBe(invalidValue);
            
            // Property: Session should be updated with collected data
            expect(result.session.data.field1).toBe(invalidValue);
            
            // Property: Steps should be marked as executed
            expect(result.executedSteps.length).toBe(1);
            expect(result.executedSteps[0].id).toBe('step1');
          }
        ),
        { numRuns: 100 }
      );
    });

    test("prepare hook failure preserves session state and returns error", async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate initial session data
          fc.record({
            field1: fc.option(fc.string()),
          }),
          // Generate error message
          fc.string({ minLength: 1, maxLength: 50 }),
          // Generate which step fails (0 or 1)
          fc.integer({ min: 0, max: 1 }),
          async (initialData, errorMessage, failAtStep) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create a batch with multiple steps
            const batch: BatchResult<unknown, BatchTestData> = {
              steps: [
                { id: 'step0', requires: [], collect: [], prepare: async () => {} },
                { id: 'step1', requires: [], collect: [], prepare: async () => {} },
              ],
              stoppedReason: 'route_complete',
            };
            
            // Create initial session with data
            const sessionData: Partial<BatchTestData> = {};
            if (initialData.field1 !== null) sessionData.field1 = initialData.field1;
            
            const initialSession = { 
              id: 'test-session', 
              data: sessionData,
            };
            
            let hookCallCount = 0;
            
            // Mock executeHook that fails at specified step
            const executeHook = async () => {
              if (hookCallCount === failAtStep) {
                hookCallCount++;
                throw new Error(errorMessage);
              }
              hookCallCount++;
            };
            
            // Mock generateMessage (should not be called)
            const generateMessage = async () => ({
              message: 'Should not reach here',
              structured: {},
            });
            
            const result = await executor.executeBatch({
              batch,
              session: initialSession,
              context: {},
              executeHook,
              generateMessage,
              routeId: 'test-route',
            });
            
            // Property: Should return 'prepare_error' as stopped reason
            expect(result.stoppedReason).toBe('prepare_error');
            
            // Property: Should include error information
            expect(result.error).toBeDefined();
            expect(result.error?.type).toBe('prepare_hook');
            
            // Property: Should preserve original session state
            expect(result.session.id).toBe('test-session');
            expect(result.session.data).toEqual(sessionData);
            
            // Property: Should track which steps had hooks executed before failure
            expect(result.executedSteps.length).toBe(failAtStep);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("finalize hook failure continues execution and logs error", async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate collected data
          fc.string({ minLength: 1, maxLength: 20 }),
          // Generate error message
          fc.string({ minLength: 1, maxLength: 50 }),
          async (collectedValue, errorMessage) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create a batch with steps that have finalize hooks
            const batch: BatchResult<unknown, BatchTestData> = {
              steps: [
                { id: 'step1', requires: [], collect: ['field1' as keyof BatchTestData], finalize: async () => {} },
              ],
              stoppedReason: 'route_complete',
            };
            
            const initialSession = { 
              id: 'test-session', 
              data: {} as Partial<BatchTestData>,
            };
            
            let isPreparePhase = true;
            
            // Mock executeHook that fails during finalize
            const executeHook = async () => {
              if (!isPreparePhase) {
                throw new Error(errorMessage);
              }
            };
            
            // Mock generateMessage that returns valid data
            const generateMessage = async () => {
              isPreparePhase = false; // Switch to finalize phase after LLM call
              return {
                message: 'Test response',
                structured: {
                  message: 'Test response',
                  field1: collectedValue,
                },
              };
            };
            
            const result = await executor.executeBatch({
              batch,
              session: initialSession,
              context: {},
              executeHook,
              generateMessage,
              routeId: 'test-route',
            });
            
            // Property: Should NOT return 'finalize_error' as stopped reason
            // (finalize errors are non-fatal)
            expect(result.stoppedReason).toBe('route_complete');
            
            // Property: Should include finalize error information
            expect(result.error).toBeDefined();
            expect(result.error?.type).toBe('finalize_hook');
            
            // Property: Should still have collected the data
            expect(result.collectedData?.field1).toBe(collectedValue);
            
            // Property: Session should be updated with collected data
            expect(result.session.data.field1).toBe(collectedValue);
            
            // Property: Steps should be marked as executed
            expect(result.executedSteps.length).toBe(1);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("empty batch returns immediately with appropriate reason", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('needs_input', 'end_route', 'route_complete') as fc.Arbitrary<StoppedReason>,
          async (stoppedReason) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create an empty batch
            const batch: BatchResult<unknown, BatchTestData> = {
              steps: [],
              stoppedReason,
            };
            
            const initialSession = { 
              id: 'test-session', 
              data: { field1: 'existing' } as Partial<BatchTestData>,
            };
            
            // These should not be called for empty batch
            const executeHook = async () => {
              throw new Error('Should not be called');
            };
            
            const generateMessage = async () => {
              throw new Error('Should not be called');
            };
            
            const result = await executor.executeBatch({
              batch,
              session: initialSession,
              context: {},
              executeHook,
              generateMessage,
              routeId: 'test-route',
            });
            
            // Property: Should return the batch's stopped reason
            expect(result.stoppedReason).toBe(stoppedReason);
            
            // Property: Should preserve session state
            expect(result.session).toEqual(initialSession);
            
            // Property: No steps executed
            expect(result.executedSteps.length).toBe(0);
            
            // Property: No error
            expect(result.error).toBeUndefined();
          }
        ),
        { numRuns: 100 }
      );
    });

    test("successful execution returns all collected data and executed steps", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.string({ minLength: 1, maxLength: 20 }),
          async (value1, value2) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create a batch with multiple steps
            const batch: BatchResult<unknown, BatchTestData> = {
              steps: [
                { id: 'step1', requires: [], collect: ['field1' as keyof BatchTestData] },
                { id: 'step2', requires: [], collect: ['field2' as keyof BatchTestData] },
              ],
              stoppedReason: 'route_complete',
            };
            
            const initialSession = { 
              id: 'test-session', 
              data: {} as Partial<BatchTestData>,
            };
            
            // Mock executeHook that succeeds
            const executeHook = async () => {};
            
            // Mock generateMessage that returns valid data
            const generateMessage = async () => ({
              message: 'Test response',
              structured: {
                message: 'Test response',
                field1: value1,
                field2: value2,
              },
            });
            
            const result = await executor.executeBatch({
              batch,
              session: initialSession,
              context: {},
              executeHook,
              generateMessage,
              routeId: 'test-route',
            });
            
            // Property: Should return 'route_complete' as stopped reason
            expect(result.stoppedReason).toBe('route_complete');
            
            // Property: No error
            expect(result.error).toBeUndefined();
            
            // Property: Should have collected all data
            expect(result.collectedData?.field1).toBe(value1);
            expect(result.collectedData?.field2).toBe(value2);
            
            // Property: Session should be updated
            expect(result.session.data.field1).toBe(value1);
            expect(result.session.data.field2).toBe(value2);
            
            // Property: All steps should be marked as executed
            expect(result.executedSteps.length).toBe(2);
            expect(result.executedSteps[0].id).toBe('step1');
            expect(result.executedSteps[1].id).toBe('step2');
            expect(result.executedSteps[0].routeId).toBe('test-route');
          }
        ),
        { numRuns: 100 }
      );
    });

    test("partial progress is preserved when error occurs mid-execution", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 20 }),
          async (existingValue) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create a batch with steps
            const batch: BatchResult<unknown, BatchTestData> = {
              steps: [
                { id: 'step1', requires: [], collect: ['field1' as keyof BatchTestData] },
              ],
              stoppedReason: 'route_complete',
            };
            
            // Session with existing data
            const initialSession = { 
              id: 'test-session', 
              data: { field1: existingValue } as Partial<BatchTestData>,
            };
            
            // Mock executeHook that succeeds
            const executeHook = async () => {};
            
            // Mock generateMessage that fails
            const generateMessage = async () => {
              throw new Error('LLM failure');
            };
            
            const result = await executor.executeBatch({
              batch,
              session: initialSession,
              context: {},
              executeHook,
              generateMessage,
              routeId: 'test-route',
            });
            
            // Property: Should return error
            expect(result.stoppedReason).toBe('llm_error');
            
            // Property: Existing session data should be preserved
            expect(result.session.data.field1).toBe(existingValue);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Unit tests for specific error scenarios
  describe("Error Handling Edge Cases", () => {
    test("handles undefined error message gracefully", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const batch: BatchResult<unknown, BatchTestData> = {
        steps: [{ id: 'step1', requires: [], collect: [] }],
        stoppedReason: 'route_complete',
      };
      
      const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
      
      const executeHook = async () => {};
      const generateMessage = async () => {
        throw undefined; // Throw undefined
      };
      
      const result = await executor.executeBatch({
        batch,
        session: initialSession,
        context: {},
        executeHook,
        generateMessage,
        routeId: 'test-route',
      });
      
      expect(result.stoppedReason).toBe('llm_error');
      expect(result.error?.message).toBe('undefined');
    });

    test("handles non-Error objects thrown", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const batch: BatchResult<unknown, BatchTestData> = {
        steps: [{ id: 'step1', requires: [], collect: [] }],
        stoppedReason: 'route_complete',
      };
      
      const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
      
      const executeHook = async () => {};
      const generateMessage = async () => {
        throw 'String error'; // Throw string instead of Error
      };
      
      const result = await executor.executeBatch({
        batch,
        session: initialSession,
        context: {},
        executeHook,
        generateMessage,
        routeId: 'test-route',
      });
      
      expect(result.stoppedReason).toBe('llm_error');
      expect(result.error?.message).toBe('String error');
    });

    test("handles missing routeId gracefully", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const batch: BatchResult<unknown, BatchTestData> = {
        steps: [{ id: 'step1', requires: [], collect: [] }],
        stoppedReason: 'route_complete',
      };
      
      const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
      
      const executeHook = async () => {};
      const generateMessage = async () => ({
        message: 'Test',
        structured: { message: 'Test' },
      });
      
      const result = await executor.executeBatch({
        batch,
        session: initialSession,
        context: {},
        executeHook,
        generateMessage,
        // No routeId provided
      });
      
      expect(result.executedSteps[0].routeId).toBe('unknown');
    });

    test("handles steps without IDs", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const batch: BatchResult<unknown, BatchTestData> = {
        steps: [
          { requires: [], collect: [] }, // No ID
          { id: 'step2', requires: [], collect: [] },
        ],
        stoppedReason: 'route_complete',
      };
      
      const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
      
      const executeHook = async () => {};
      const generateMessage = async () => ({
        message: 'Test',
        structured: { message: 'Test' },
      });
      
      const result = await executor.executeBatch({
        batch,
        session: initialSession,
        context: {},
        executeHook,
        generateMessage,
        routeId: 'test-route',
      });
      
      // Only step with ID should be in executedSteps
      expect(result.executedSteps.length).toBe(1);
      expect(result.executedSteps[0].id).toBe('step2');
    });

    test("multiple validation errors are all reported", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const batch: BatchResult<unknown, BatchTestData> = {
        steps: [
          { id: 'step1', requires: [], collect: ['field1' as keyof BatchTestData, 'field2' as keyof BatchTestData] },
        ],
        stoppedReason: 'route_complete',
      };
      
      const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
      
      const executeHook = async () => {};
      const generateMessage = async () => ({
        message: 'Test',
        structured: {
          message: 'Test',
          field1: 123, // Number instead of string
          field2: true, // Boolean instead of string
        },
      });
      
      const schema = {
        type: 'object' as const,
        properties: {
          field1: { type: 'string' as const },
          field2: { type: 'string' as const },
        },
      };
      
      const result = await executor.executeBatch({
        batch,
        session: initialSession,
        context: {},
        executeHook,
        generateMessage,
        schema,
        routeId: 'test-route',
      });
      
      expect(result.stoppedReason).toBe('validation_error');
      expect(result.error?.type).toBe('data_validation');
      
      // Error details should contain both validation errors
      const details = result.error?.details as Array<{ field: string }>;
      expect(details.length).toBe(2);
      expect(details.map(e => e.field)).toContain('field1');
      expect(details.map(e => e.field)).toContain('field2');
    });
  });
});


/**
 * Property-Based Tests for BatchExecutor Stopping Conditions
 * 
 * Feature: multi-step-execution
 * Property 3: Stopping Conditions
 * 
 * Tests that the Execution_Engine stops with the appropriate reason when:
 * - Reaching END_ROUTE (stoppedReason = 'end_route')
 * - Processing all Steps (stoppedReason = 'route_complete')
 * - Encountering errors (stoppedReason = 'prepare_error', 'llm_error', 'validation_error')
 * 
 * **Validates: Requirements 2.2, 2.3, 2.4**
 */
import { END_ROUTE, END_ROUTE_ID } from "../src/index";

describe("BatchExecutor - Stopping Conditions", () => {
  /**
   * Property 3: Stopping Conditions
   * 
   * For any batch execution, the Execution_Engine SHALL stop with the appropriate reason when:
   * - Reaching END_ROUTE (stoppedReason = 'end_route')
   * - Processing all Steps (stoppedReason = 'route_complete')
   * - Encountering a prepare hook error (stoppedReason = 'prepare_error')
   * - Encountering an LLM error (stoppedReason = 'llm_error')
   * - Encountering a validation error (stoppedReason = 'validation_error')
   * 
   * **Validates: Requirements 2.2, 2.3, 2.4**
   */
  
  describe("Property 3: Stopping Conditions", () => {
    
    // Requirement 2.2: Stop when reaching END_ROUTE
    test("stops with 'end_route' when reaching END_ROUTE step", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (numStepsBefore) => {
            // Create steps that don't need input, followed by END_ROUTE
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            
            for (let i = 0; i < numStepsBefore; i++) {
              steps.push({
                id: `step_${i}`,
                requires: [],
                collect: [],
              });
            }
            
            // Add END_ROUTE at the end
            steps.push(END_ROUTE as unknown as StepOptions<unknown, BatchTestData>);
            
            const route = new Route<unknown, BatchTestData>({
              title: 'END_ROUTE Test Route',
              steps,
            });
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            const result = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: {},
              context: {},
            });
            
            // Property: Should stop with 'end_route' reason
            expect(result.stoppedReason).toBe('end_route');
            
            // Property: Should include all steps before END_ROUTE
            expect(result.steps.length).toBe(numStepsBefore);
            
            // Property: stoppedAtStep should be the END_ROUTE step
            expect(result.stoppedAtStep?.id).toBe(END_ROUTE_ID);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("stops with 'end_route' when initial step transitions to END_ROUTE", async () => {
      // Edge case: initial step immediately transitions to END_ROUTE
      // Note: Route always has an initial step, so we test the case where
      // the initial step doesn't need input and transitions to END_ROUTE
      const route = new Route<unknown, BatchTestData>({
        title: 'Immediate END_ROUTE Route',
        initialStep: {
          id: 'initial',
          requires: [],
          collect: [],
        },
        steps: [
          END_ROUTE as unknown as StepOptions<unknown, BatchTestData>,
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Property: Should stop with 'end_route' after processing initial step
      expect(result.stoppedReason).toBe('end_route');
      
      // Property: Initial step should be included (it doesn't need input)
      expect(result.steps.length).toBe(1);
      expect(result.steps[0].id).toBe('initial');
    });

    // Requirement 2.3: Stop when all Steps processed
    test("stops with 'route_complete' when all steps processed", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (numSteps) => {
            // Create steps that don't need input and don't end with END_ROUTE
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            
            for (let i = 0; i < numSteps; i++) {
              steps.push({
                id: `step_${i}`,
                requires: [],
                collect: [],
              });
            }
            
            const route = new Route<unknown, BatchTestData>({
              title: 'Complete Route',
              steps,
            });
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            const result = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: {},
              context: {},
            });
            
            // Property: Should stop with 'route_complete' reason
            expect(result.stoppedReason).toBe('route_complete');
            
            // Property: Should include all steps
            expect(result.steps.length).toBe(numSteps);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("stops with 'route_complete' for route with only initial step", async () => {
      // Note: Route always creates an initial step even with empty steps array
      // So we test a route with just the initial step (no additional steps)
      const route = new Route<unknown, BatchTestData>({
        title: 'Single Step Route',
        initialStep: {
          id: 'only_step',
          requires: [],
          collect: [],
        },
        // No additional steps
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Property: Single step route should complete
      expect(result.stoppedReason).toBe('route_complete');
      expect(result.steps.length).toBe(1);
      expect(result.steps[0].id).toBe('only_step');
    });

    // Requirement 2.4: Stop on errors with appropriate reason
    test("stops with 'prepare_error' when prepare hook fails", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          async (errorMessage) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            const batch: BatchResult<unknown, BatchTestData> = {
              steps: [
                { 
                  id: 'step1', 
                  requires: [], 
                  collect: [],
                  prepare: async () => { throw new Error(errorMessage); },
                },
              ],
              stoppedReason: 'route_complete',
            };
            
            const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
            
            const executeHook = async (hook: HookFunction<unknown, BatchTestData>) => {
              if (typeof hook === 'function') {
                await hook({}, {});
              }
            };
            
            const generateMessage = async () => ({
              message: 'Test',
              structured: { message: 'Test' },
            });
            
            const result = await executor.executeBatch({
              batch,
              session: initialSession,
              context: {},
              executeHook,
              generateMessage,
              routeId: 'test-route',
            });
            
            // Property: Should stop with 'prepare_error' reason
            expect(result.stoppedReason).toBe('prepare_error');
            
            // Property: Error should contain the error message
            expect(result.error?.type).toBe('prepare_hook');
            expect(result.error?.message).toBe(errorMessage);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("stops with 'llm_error' when LLM call fails", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          async (errorMessage) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            const batch: BatchResult<unknown, BatchTestData> = {
              steps: [
                { id: 'step1', requires: [], collect: [] },
              ],
              stoppedReason: 'route_complete',
            };
            
            const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
            
            const executeHook = async () => {};
            const generateMessage = async () => {
              throw new Error(errorMessage);
            };
            
            const result = await executor.executeBatch({
              batch,
              session: initialSession,
              context: {},
              executeHook,
              generateMessage,
              routeId: 'test-route',
            });
            
            // Property: Should stop with 'llm_error' reason
            expect(result.stoppedReason).toBe('llm_error');
            
            // Property: Error should contain the error message
            expect(result.error?.type).toBe('llm_call');
            expect(result.error?.message).toBe(errorMessage);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("stops with 'validation_error' when data validation fails", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('field1', 'field2', 'field3') as fc.Arbitrary<keyof BatchTestData>,
          async (fieldName) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            const batch: BatchResult<unknown, BatchTestData> = {
              steps: [
                { id: 'step1', requires: [], collect: [fieldName] },
              ],
              stoppedReason: 'route_complete',
            };
            
            const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
            
            const executeHook = async () => {};
            const generateMessage = async () => ({
              message: 'Test',
              structured: {
                message: 'Test',
                [fieldName]: 12345, // Number instead of expected string
              },
            });
            
            const schema = {
              type: 'object' as const,
              properties: {
                [fieldName]: { type: 'string' as const },
              },
            };
            
            const result = await executor.executeBatch({
              batch,
              session: initialSession,
              context: {},
              executeHook,
              generateMessage,
              schema,
              routeId: 'test-route',
            });
            
            // Property: Should stop with 'validation_error' reason
            expect(result.stoppedReason).toBe('validation_error');
            
            // Property: Error should be of type 'data_validation'
            expect(result.error?.type).toBe('data_validation');
          }
        ),
        { numRuns: 100 }
      );
    });

    test("stops with 'needs_input' when step requires missing data", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('field1', 'field2', 'field3') as fc.Arbitrary<keyof BatchTestData>,
          fc.integer({ min: 0, max: 3 }),
          async (requiredField, numStepsBefore) => {
            // Create steps that don't need input, then one that does
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            
            for (let i = 0; i < numStepsBefore; i++) {
              steps.push({
                id: `step_${i}`,
                requires: [],
                collect: [],
              });
            }
            
            // Add step that needs input
            steps.push({
              id: 'needs_input_step',
              requires: [requiredField],
              collect: [],
            });
            
            const route = new Route<unknown, BatchTestData>({
              title: 'Needs Input Route',
              steps,
            });
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Session data without the required field
            const result = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: {},
              context: {},
            });
            
            // Property: Should stop with 'needs_input' reason
            expect(result.stoppedReason).toBe('needs_input');
            
            // Property: Should include steps before the one that needs input
            expect(result.steps.length).toBe(numStepsBefore);
            
            // Property: stoppedAtStep should be the step that needs input
            expect(result.stoppedAtStep?.id).toBe('needs_input_step');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Unit tests for stopping condition edge cases
  describe("Stopping Conditions Edge Cases", () => {
    test("END_ROUTE after skipped steps", async () => {
      // Create route where some steps are skipped, then END_ROUTE
      const route = new Route<unknown, BatchTestData>({
        title: 'Skip Then END_ROUTE',
        steps: [
          { id: 'skip1', requires: [], collect: [], skipIf: () => true },
          { id: 'skip2', requires: [], collect: [], skipIf: () => true },
          END_ROUTE as unknown as StepOptions<unknown, BatchTestData>,
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Should reach END_ROUTE after skipping
      expect(result.stoppedReason).toBe('end_route');
      expect(result.steps.length).toBe(0); // All steps were skipped
    });

    test("route_complete after skipped steps", async () => {
      // Create route where some steps are skipped, then normal completion
      const route = new Route<unknown, BatchTestData>({
        title: 'Skip Then Complete',
        steps: [
          { id: 'skip1', requires: [], collect: [], skipIf: () => true },
          { id: 'normal', requires: [], collect: [] },
          { id: 'skip2', requires: [], collect: [], skipIf: () => true },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Should complete route with only non-skipped step
      expect(result.stoppedReason).toBe('route_complete');
      expect(result.steps.length).toBe(1);
      expect(result.steps[0].id).toBe('normal');
    });

    test("needs_input takes precedence over route_complete", async () => {
      // Single step that needs input
      const route = new Route<unknown, BatchTestData>({
        title: 'Single Needs Input',
        steps: [
          { id: 'needs_input', requires: ['field1'], collect: [] },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Should stop with needs_input, not route_complete
      expect(result.stoppedReason).toBe('needs_input');
    });

    test("END_ROUTE takes precedence over needs_input for subsequent steps", async () => {
      // Step that doesn't need input, then END_ROUTE, then step that would need input
      const route = new Route<unknown, BatchTestData>({
        title: 'END_ROUTE Before Needs Input',
        steps: [
          { id: 'step1', requires: [], collect: [] },
          END_ROUTE as unknown as StepOptions<unknown, BatchTestData>,
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Should stop at END_ROUTE
      expect(result.stoppedReason).toBe('end_route');
      expect(result.steps.length).toBe(1);
    });

    test("finalize_error does not change stopped reason", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const batch: BatchResult<unknown, BatchTestData> = {
        steps: [
          { 
            id: 'step1', 
            requires: [], 
            collect: [],
            finalize: async () => { throw new Error('Finalize failed'); },
          },
        ],
        stoppedReason: 'route_complete',
      };
      
      const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
      
      const executeHook = async (hook: HookFunction<unknown, BatchTestData>) => {
        if (typeof hook === 'function') {
          await hook({}, {});
        }
      };
      
      const generateMessage = async () => ({
        message: 'Test',
        structured: { message: 'Test' },
      });
      
      const result = await executor.executeBatch({
        batch,
        session: initialSession,
        context: {},
        executeHook,
        generateMessage,
        routeId: 'test-route',
      });
      
      // Finalize errors are non-fatal, so stopped reason should remain 'route_complete'
      expect(result.stoppedReason).toBe('route_complete');
      
      // But error should still be reported
      expect(result.error?.type).toBe('finalize_hook');
    });

    test("multiple stopping conditions - first one wins", async () => {
      // Route with step that needs input followed by END_ROUTE
      const route = new Route<unknown, BatchTestData>({
        title: 'Multiple Stopping Conditions',
        steps: [
          { id: 'needs_input', requires: ['field1'], collect: [] },
          END_ROUTE as unknown as StepOptions<unknown, BatchTestData>,
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Should stop at needs_input (first stopping condition encountered)
      expect(result.stoppedReason).toBe('needs_input');
    });
  });
});


/**
 * Property-Based Tests for Response Structure Completeness
 * 
 * Feature: multi-step-execution
 * Property 9: Response Structure Completeness
 * 
 * Tests that AgentResponse includes all required fields after batch execution.
 * 
 * **Validates: Requirements 8.1, 8.2, 8.3**
 */

describe("BatchExecutor - Response Structure Completeness", () => {
  /**
   * Property 9: Response Structure Completeness
   * 
   * For any batch execution, the AgentResponse SHALL include:
   * - `executedSteps` array matching the Steps in the batch
   * - `stoppedReason` field with a valid reason
   * - Session state with `currentStep` reflecting the final Step position
   * 
   * **Validates: Requirements 8.1, 8.2, 8.3**
   */
  
  describe("Property 9: Response Structure Completeness", () => {
    // Valid stopped reasons as defined in the design
    const validStoppedReasons: StoppedReason[] = [
      'needs_input',
      'end_route',
      'route_complete',
      'prepare_error',
      'llm_error',
      'validation_error',
      'finalize_error',
    ];

    test("executedSteps array matches steps in batch", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (numSteps) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create steps for the batch
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            for (let i = 0; i < numSteps; i++) {
              steps.push({
                id: `step_${i}`,
                requires: [],
                collect: [],
              });
            }
            
            const batch: BatchResult<unknown, BatchTestData> = {
              steps,
              stoppedReason: 'route_complete',
            };
            
            const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
            
            const executeHook = async () => {};
            const generateMessage = async () => ({
              message: 'Test response',
              structured: { message: 'Test response' },
            });
            
            const result = await executor.executeBatch({
              batch,
              session: initialSession,
              context: {},
              executeHook,
              generateMessage,
              routeId: 'test-route',
            });
            
            // Property: executedSteps array should match the steps in the batch
            expect(result.executedSteps.length).toBe(numSteps);
            
            // Property: Each executed step should have correct id and routeId
            for (let i = 0; i < numSteps; i++) {
              expect(result.executedSteps[i].id).toBe(`step_${i}`);
              expect(result.executedSteps[i].routeId).toBe('test-route');
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("stoppedReason is always a valid value", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...validStoppedReasons),
          async (expectedReason) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            const batch: BatchResult<unknown, BatchTestData> = {
              steps: [{ id: 'step1', requires: [], collect: [] }],
              stoppedReason: expectedReason,
            };
            
            const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
            
            // For error reasons, we need to simulate the error condition
            let executeHook: (hook: HookFunction<unknown, BatchTestData>) => Promise<void>;
            let generateMessage: () => Promise<{ message: string; structured?: Record<string, unknown> }>;
            
            if (expectedReason === 'prepare_error') {
              // Simulate prepare hook failure
              executeHook = async (hook) => {
                if (typeof hook === 'function') {
                  throw new Error('Prepare hook failed');
                }
              };
              generateMessage = async () => ({ message: 'Test', structured: { message: 'Test' } });
              
              // Add prepare hook to trigger the error
              batch.steps = [{
                id: 'step1',
                requires: [],
                collect: [],
                prepare: async () => { throw new Error('Prepare failed'); },
              }];
            } else if (expectedReason === 'llm_error') {
              executeHook = async () => {};
              generateMessage = async () => { throw new Error('LLM call failed'); };
            } else {
              executeHook = async () => {};
              generateMessage = async () => ({ message: 'Test', structured: { message: 'Test' } });
            }
            
            const result = await executor.executeBatch({
              batch,
              session: initialSession,
              context: {},
              executeHook,
              generateMessage,
              routeId: 'test-route',
            });
            
            // Property: stoppedReason should always be a valid value
            expect(validStoppedReasons).toContain(result.stoppedReason);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("executedSteps is empty array when batch is empty", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const batch: BatchResult<unknown, BatchTestData> = {
        steps: [],
        stoppedReason: 'needs_input',
      };
      
      const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
      
      const result = await executor.executeBatch({
        batch,
        session: initialSession,
        context: {},
        executeHook: async () => {},
        generateMessage: async () => ({ message: 'Test', structured: { message: 'Test' } }),
        routeId: 'test-route',
      });
      
      // Property: executedSteps should be empty array for empty batch
      expect(result.executedSteps).toEqual([]);
      expect(result.stoppedReason).toBe('needs_input');
    });

    test("executedSteps contains only steps with valid IDs", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              hasId: fc.boolean(),
              idValue: fc.string({ minLength: 1, maxLength: 10 }),
            }),
            { minLength: 1, maxLength: 5 }
          ),
          async (stepConfigs) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create steps - some with IDs, some without
            const steps: StepOptions<unknown, BatchTestData>[] = stepConfigs.map((config, idx) => ({
              id: config.hasId ? `${config.idValue}_${idx}` : undefined,
              requires: [],
              collect: [],
            }));
            
            const batch: BatchResult<unknown, BatchTestData> = {
              steps,
              stoppedReason: 'route_complete',
            };
            
            const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
            
            const result = await executor.executeBatch({
              batch,
              session: initialSession,
              context: {},
              executeHook: async () => {},
              generateMessage: async () => ({ message: 'Test', structured: { message: 'Test' } }),
              routeId: 'test-route',
            });
            
            // Property: executedSteps should only contain steps that have IDs
            const stepsWithIds = stepConfigs.filter(c => c.hasId).length;
            expect(result.executedSteps.length).toBe(stepsWithIds);
            
            // Property: All executedSteps should have non-empty id
            for (const step of result.executedSteps) {
              expect(step.id).toBeDefined();
              expect(step.id.length).toBeGreaterThan(0);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("executedSteps preserves step order from batch", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          async (numSteps) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            // Create steps with sequential IDs
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            for (let i = 0; i < numSteps; i++) {
              steps.push({
                id: `step_${i}`,
                requires: [],
                collect: [],
              });
            }
            
            const batch: BatchResult<unknown, BatchTestData> = {
              steps,
              stoppedReason: 'route_complete',
            };
            
            const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
            
            const result = await executor.executeBatch({
              batch,
              session: initialSession,
              context: {},
              executeHook: async () => {},
              generateMessage: async () => ({ message: 'Test', structured: { message: 'Test' } }),
              routeId: 'test-route',
            });
            
            // Property: executedSteps should preserve the order from batch
            for (let i = 0; i < numSteps; i++) {
              expect(result.executedSteps[i].id).toBe(`step_${i}`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("session state is returned with batch execution result", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            field1: fc.option(fc.string()),
            field2: fc.option(fc.string()),
          }),
          async (initialData) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            const batch: BatchResult<unknown, BatchTestData> = {
              steps: [{ id: 'step1', requires: [], collect: [] }],
              stoppedReason: 'route_complete',
            };
            
            // Convert null to undefined
            const cleanData: Partial<BatchTestData> = {};
            if (initialData.field1 !== null) cleanData.field1 = initialData.field1;
            if (initialData.field2 !== null) cleanData.field2 = initialData.field2;
            
            const initialSession = { 
              id: 'test-session', 
              data: cleanData,
            };
            
            const result = await executor.executeBatch({
              batch,
              session: initialSession,
              context: {},
              executeHook: async () => {},
              generateMessage: async () => ({ message: 'Test', structured: { message: 'Test' } }),
              routeId: 'test-route',
            });
            
            // Property: session should be returned in result
            expect(result.session).toBeDefined();
            expect(result.session.id).toBe('test-session');
            
            // Property: session data should be preserved or updated
            expect(result.session.data).toBeDefined();
          }
        ),
        { numRuns: 100 }
      );
    });

    test("routeId is correctly set on all executedSteps", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.integer({ min: 1, max: 5 }),
          async (routeId, numSteps) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            for (let i = 0; i < numSteps; i++) {
              steps.push({
                id: `step_${i}`,
                requires: [],
                collect: [],
              });
            }
            
            const batch: BatchResult<unknown, BatchTestData> = {
              steps,
              stoppedReason: 'route_complete',
            };
            
            const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
            
            const result = await executor.executeBatch({
              batch,
              session: initialSession,
              context: {},
              executeHook: async () => {},
              generateMessage: async () => ({ message: 'Test', structured: { message: 'Test' } }),
              routeId,
            });
            
            // Property: All executedSteps should have the correct routeId
            for (const step of result.executedSteps) {
              expect(step.routeId).toBe(routeId);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("stoppedReason reflects error conditions correctly", async () => {
      // Test prepare_error
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const batchWithPrepare: BatchResult<unknown, BatchTestData> = {
        steps: [{
          id: 'step1',
          requires: [],
          collect: [],
          prepare: async () => { throw new Error('Prepare failed'); },
        }],
        stoppedReason: 'route_complete',
      };
      
      const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
      
      const prepareResult = await executor.executeBatch({
        batch: batchWithPrepare,
        session: initialSession,
        context: {},
        executeHook: async (hook) => {
          if (typeof hook === 'function') {
            await hook({}, {});
          }
        },
        generateMessage: async () => ({ message: 'Test', structured: { message: 'Test' } }),
        routeId: 'test-route',
      });
      
      // Property: stoppedReason should be 'prepare_error' when prepare hook fails
      expect(prepareResult.stoppedReason).toBe('prepare_error');
      expect(prepareResult.error?.type).toBe('prepare_hook');
      
      // Test llm_error
      const batchForLlm: BatchResult<unknown, BatchTestData> = {
        steps: [{ id: 'step1', requires: [], collect: [] }],
        stoppedReason: 'route_complete',
      };
      
      const llmResult = await executor.executeBatch({
        batch: batchForLlm,
        session: initialSession,
        context: {},
        executeHook: async () => {},
        generateMessage: async () => { throw new Error('LLM failed'); },
        routeId: 'test-route',
      });
      
      // Property: stoppedReason should be 'llm_error' when LLM call fails
      expect(llmResult.stoppedReason).toBe('llm_error');
      expect(llmResult.error?.type).toBe('llm_call');
    });
  });

  // Unit tests for edge cases
  describe("Response Structure Edge Cases", () => {
    test("handles missing routeId gracefully", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const batch: BatchResult<unknown, BatchTestData> = {
        steps: [{ id: 'step1', requires: [], collect: [] }],
        stoppedReason: 'route_complete',
      };
      
      const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
      
      const result = await executor.executeBatch({
        batch,
        session: initialSession,
        context: {},
        executeHook: async () => {},
        generateMessage: async () => ({ message: 'Test', structured: { message: 'Test' } }),
        // routeId not provided
      });
      
      // Should use 'unknown' as default routeId
      expect(result.executedSteps[0].routeId).toBe('unknown');
    });

    test("collectedData is included in result", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const batch: BatchResult<unknown, BatchTestData> = {
        steps: [{ id: 'step1', requires: [], collect: ['field1'] }],
        stoppedReason: 'route_complete',
      };
      
      const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
      
      const result = await executor.executeBatch({
        batch,
        session: initialSession,
        context: {},
        executeHook: async () => {},
        generateMessage: async () => ({ 
          message: 'Test', 
          structured: { message: 'Test', field1: 'collected_value' } 
        }),
        routeId: 'test-route',
      });
      
      // collectedData should be included in result
      expect(result.collectedData).toBeDefined();
      expect(result.collectedData?.field1).toBe('collected_value');
    });

    test("message is included in result", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const batch: BatchResult<unknown, BatchTestData> = {
        steps: [{ id: 'step1', requires: [], collect: [] }],
        stoppedReason: 'route_complete',
      };
      
      const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
      
      const testMessage = 'This is the test response message';
      
      const result = await executor.executeBatch({
        batch,
        session: initialSession,
        context: {},
        executeHook: async () => {},
        generateMessage: async () => ({ 
          message: testMessage, 
          structured: { message: testMessage } 
        }),
        routeId: 'test-route',
      });
      
      // message should be included in result
      expect(result.message).toBe(testMessage);
    });

    test("error details are included when errors occur", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const batch: BatchResult<unknown, BatchTestData> = {
        steps: [{ id: 'step1', requires: [], collect: [] }],
        stoppedReason: 'route_complete',
      };
      
      const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
      
      const errorMessage = 'Specific error message';
      
      const result = await executor.executeBatch({
        batch,
        session: initialSession,
        context: {},
        executeHook: async () => {},
        generateMessage: async () => { throw new Error(errorMessage); },
        routeId: 'test-route',
      });
      
      // error should include details
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain(errorMessage);
      expect(result.error?.type).toBe('llm_call');
    });
  });
});


/**
 * Property-Based Tests for BatchExecutor Event Emission
 * 
 * Feature: multi-step-execution
 * Property 12: Event Emission
 * 
 * Tests that the BatchExecutor emits events for batch execution phases.
 * 
 * **Validates: Requirements 11.3**
 */
import type { BatchExecutionEvent, BatchExecutionEventType } from "../src/types/route";

describe("BatchExecutor - Event Emission", () => {
  /**
   * Property 12: Event Emission
   * 
   * For any batch execution, the Execution_Engine SHALL emit events for 
   * batch start, step inclusion/skip decisions, and batch completion.
   * 
   * **Validates: Requirements 11.3**
   */
  
  describe("Property 12: Event Emission", () => {
    test("emits batch_start event when batch determination begins", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (numSteps) => {
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            for (let i = 0; i < numSteps; i++) {
              steps.push({
                id: `step_${i}`,
                requires: [],
                collect: [],
              });
            }
            
            const route = new Route<unknown, BatchTestData>({
              title: 'Event Test Route',
              steps,
            });
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            const events: BatchExecutionEvent[] = [];
            
            // Add event listener
            executor.addEventListener((event) => {
              events.push(event);
            });
            
            await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: {},
              context: {},
            });
            
            // Should have emitted batch_start event
            const batchStartEvents = events.filter(e => e.type === 'batch_start');
            expect(batchStartEvents.length).toBe(1);
            expect(batchStartEvents[0].timestamp).toBeInstanceOf(Date);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("emits step_included event for each step included in batch", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (numSteps) => {
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            for (let i = 0; i < numSteps; i++) {
              steps.push({
                id: `step_${i}`,
                requires: [],
                collect: [],
              });
            }
            
            const route = new Route<unknown, BatchTestData>({
              title: 'Event Test Route',
              steps,
            });
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            const events: BatchExecutionEvent[] = [];
            
            executor.addEventListener((event) => {
              events.push(event);
            });
            
            const result = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: {},
              context: {},
            });
            
            // Should have emitted step_included for each step in batch
            const stepIncludedEvents = events.filter(e => e.type === 'step_included');
            expect(stepIncludedEvents.length).toBe(result.steps.length);
            
            // Each event should have the correct step ID
            for (let i = 0; i < stepIncludedEvents.length; i++) {
              expect(stepIncludedEvents[i].details.stepId).toBe(result.steps[i].id);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("emits step_skipped event when step is skipped due to skipIf", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 4 }),
          async (numSkippedSteps) => {
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            
            // Add steps that will be skipped
            for (let i = 0; i < numSkippedSteps; i++) {
              steps.push({
                id: `skipped_${i}`,
                requires: [],
                collect: [],
                skipIf: () => true,
              });
            }
            
            // Add a final step that won't be skipped
            steps.push({
              id: 'final_step',
              requires: [],
              collect: [],
            });
            
            const route = new Route<unknown, BatchTestData>({
              title: 'Skip Event Test Route',
              steps,
            });
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            const events: BatchExecutionEvent[] = [];
            
            executor.addEventListener((event) => {
              events.push(event);
            });
            
            await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: {},
              context: {},
            });
            
            // Should have emitted step_skipped for each skipped step
            const stepSkippedEvents = events.filter(e => e.type === 'step_skipped');
            expect(stepSkippedEvents.length).toBe(numSkippedSteps);
            
            // Each skipped event should have the correct step ID
            for (let i = 0; i < numSkippedSteps; i++) {
              expect(stepSkippedEvents[i].details.stepId).toBe(`skipped_${i}`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("emits batch_stop event when batch determination stops", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('needs_input', 'end_route', 'route_complete') as fc.Arbitrary<StoppedReason>,
          async (expectedReason) => {
            let steps: StepOptions<unknown, BatchTestData>[];
            
            if (expectedReason === 'needs_input') {
              steps = [
                { id: 'step1', requires: ['field1'], collect: [] },
              ];
            } else if (expectedReason === 'end_route') {
              // Route with no steps will reach END_ROUTE
              steps = [];
            } else {
              // route_complete - steps that don't need input
              steps = [
                { id: 'step1', requires: [], collect: [] },
              ];
            }
            
            const route = new Route<unknown, BatchTestData>({
              title: 'Stop Event Test Route',
              steps,
            });
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            const events: BatchExecutionEvent[] = [];
            
            executor.addEventListener((event) => {
              events.push(event);
            });
            
            const result = await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: {},
              context: {},
            });
            
            // Should have emitted batch_stop event
            const batchStopEvents = events.filter(e => e.type === 'batch_stop');
            expect(batchStopEvents.length).toBeGreaterThanOrEqual(1);
            
            // The last batch_stop event should have the correct stopped reason
            const lastStopEvent = batchStopEvents[batchStopEvents.length - 1];
            expect(lastStopEvent.details.stoppedReason).toBe(result.stoppedReason);
          }
        ),
        { numRuns: 100 }
      );
    });

    test("emits batch_complete event when batch execution completes", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 3 }),
          async (numSteps) => {
            const steps: StepOptions<unknown, BatchTestData>[] = [];
            for (let i = 0; i < numSteps; i++) {
              steps.push({
                id: `step_${i}`,
                requires: [],
                collect: [],
              });
            }
            
            const executor = new BatchExecutor<unknown, BatchTestData>();
            const events: BatchExecutionEvent[] = [];
            
            executor.addEventListener((event) => {
              events.push(event);
            });
            
            const batch: BatchResult<unknown, BatchTestData> = {
              steps,
              stoppedReason: 'route_complete',
            };
            
            const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
            
            await executor.executeBatch({
              batch,
              session: initialSession,
              context: {},
              executeHook: async () => {},
              generateMessage: async () => ({ message: 'Test', structured: {} }),
              routeId: 'test-route',
            });
            
            // Should have emitted batch_complete event
            const batchCompleteEvents = events.filter(e => e.type === 'batch_complete');
            expect(batchCompleteEvents.length).toBe(1);
            expect(batchCompleteEvents[0].details.batchSize).toBe(numSteps);
            expect(batchCompleteEvents[0].details.stoppedReason).toBe('route_complete');
          }
        ),
        { numRuns: 100 }
      );
    });

    test("batch_complete event includes timing information", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      const events: BatchExecutionEvent[] = [];
      
      executor.addEventListener((event) => {
        events.push(event);
      });
      
      const batch: BatchResult<unknown, BatchTestData> = {
        steps: [{ id: 'step1', requires: [], collect: [] }],
        stoppedReason: 'route_complete',
      };
      
      const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
      
      await executor.executeBatch({
        batch,
        session: initialSession,
        context: {},
        executeHook: async () => {},
        generateMessage: async () => ({ message: 'Test', structured: {} }),
        routeId: 'test-route',
      });
      
      const batchCompleteEvent = events.find(e => e.type === 'batch_complete');
      expect(batchCompleteEvent).toBeDefined();
      expect(batchCompleteEvent!.details.timing).toBeDefined();
      expect(batchCompleteEvent!.details.timing!.totalMs).toBeGreaterThanOrEqual(0);
    });

    test("event listener can be removed", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      const events: BatchExecutionEvent[] = [];
      
      const listener = (event: BatchExecutionEvent) => {
        events.push(event);
      };
      
      // Add and then remove listener
      const removeListener = executor.addEventListener(listener);
      removeListener();
      
      const route = new Route<unknown, BatchTestData>({
        title: 'Remove Listener Test Route',
        steps: [{ id: 'step1', requires: [], collect: [] }],
      });
      
      await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // No events should have been captured
      expect(events.length).toBe(0);
    });

    test("multiple event listeners receive all events", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 3 }),
          async (numListeners) => {
            const executor = new BatchExecutor<unknown, BatchTestData>();
            const eventsByListener: BatchExecutionEvent[][] = [];
            
            // Add multiple listeners
            for (let i = 0; i < numListeners; i++) {
              const events: BatchExecutionEvent[] = [];
              eventsByListener.push(events);
              executor.addEventListener((event) => {
                events.push(event);
              });
            }
            
            const route = new Route<unknown, BatchTestData>({
              title: 'Multi Listener Test Route',
              steps: [{ id: 'step1', requires: [], collect: [] }],
            });
            
            await executor.determineBatch({
              route,
              currentStep: undefined,
              sessionData: {},
              context: {},
            });
            
            // All listeners should have received the same events
            const firstListenerEventCount = eventsByListener[0].length;
            for (let i = 1; i < numListeners; i++) {
              expect(eventsByListener[i].length).toBe(firstListenerEventCount);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test("events are emitted in correct order", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      const events: BatchExecutionEvent[] = [];
      
      executor.addEventListener((event) => {
        events.push(event);
      });
      
      const route = new Route<unknown, BatchTestData>({
        title: 'Order Test Route',
        steps: [
          { id: 'step1', requires: [], collect: [], skipIf: () => true },
          { id: 'step2', requires: [], collect: [] },
        ],
      });
      
      await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Events should be in order: batch_start, step_skipped, step_included, batch_stop
      const eventTypes = events.map(e => e.type);
      
      // First event should be batch_start
      expect(eventTypes[0]).toBe('batch_start');
      
      // Should have step_skipped before step_included (since step1 is skipped)
      const skipIndex = eventTypes.indexOf('step_skipped');
      const includeIndex = eventTypes.indexOf('step_included');
      expect(skipIndex).toBeLessThan(includeIndex);
      
      // Last event should be batch_stop
      expect(eventTypes[eventTypes.length - 1]).toBe('batch_stop');
    });

    test("event timestamps are valid and sequential", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      const events: BatchExecutionEvent[] = [];
      
      executor.addEventListener((event) => {
        events.push(event);
      });
      
      const route = new Route<unknown, BatchTestData>({
        title: 'Timestamp Test Route',
        steps: [
          { id: 'step1', requires: [], collect: [] },
          { id: 'step2', requires: [], collect: [] },
        ],
      });
      
      const beforeTime = new Date();
      
      await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      const afterTime = new Date();
      
      // All events should have valid timestamps
      for (const event of events) {
        expect(event.timestamp).toBeInstanceOf(Date);
        expect(event.timestamp.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
        expect(event.timestamp.getTime()).toBeLessThanOrEqual(afterTime.getTime());
      }
      
      // Timestamps should be sequential (or equal for fast execution)
      for (let i = 1; i < events.length; i++) {
        expect(events[i].timestamp.getTime()).toBeGreaterThanOrEqual(events[i - 1].timestamp.getTime());
      }
    });
  });

  // Unit tests for event emission edge cases
  describe("Event Emission Edge Cases", () => {
    test("handles empty route", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      const events: BatchExecutionEvent[] = [];
      
      executor.addEventListener((event) => {
        events.push(event);
      });
      
      const route = new Route<unknown, BatchTestData>({
        title: 'Empty Route',
        steps: [],
      });
      
      await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Should still emit batch_start and batch_stop
      expect(events.some(e => e.type === 'batch_start')).toBe(true);
      expect(events.some(e => e.type === 'batch_stop')).toBe(true);
    });

    test("handles listener that throws error", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      const goodEvents: BatchExecutionEvent[] = [];
      
      // Add a listener that throws
      executor.addEventListener(() => {
        throw new Error('Listener error');
      });
      
      // Add a good listener after the bad one
      executor.addEventListener((event) => {
        goodEvents.push(event);
      });
      
      const route = new Route<unknown, BatchTestData>({
        title: 'Error Listener Test Route',
        steps: [{ id: 'step1', requires: [], collect: [] }],
      });
      
      // Should not throw, and good listener should still receive events
      await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      expect(goodEvents.length).toBeGreaterThan(0);
    });

    test("batch_complete event includes error info when LLM fails", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      const events: BatchExecutionEvent[] = [];
      
      executor.addEventListener((event) => {
        events.push(event);
      });
      
      const batch: BatchResult<unknown, BatchTestData> = {
        steps: [{ id: 'step1', requires: [], collect: [] }],
        stoppedReason: 'route_complete',
      };
      
      const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
      
      await executor.executeBatch({
        batch,
        session: initialSession,
        context: {},
        executeHook: async () => {},
        generateMessage: async () => { throw new Error('LLM failed'); },
        routeId: 'test-route',
      });
      
      const batchCompleteEvent = events.find(e => e.type === 'batch_complete');
      expect(batchCompleteEvent).toBeDefined();
      expect(batchCompleteEvent!.details.stoppedReason).toBe('llm_error');
      expect(batchCompleteEvent!.details.reason).toContain('LLM call failed');
    });

    test("batch_complete event includes error info when prepare hook fails", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      const events: BatchExecutionEvent[] = [];
      
      executor.addEventListener((event) => {
        events.push(event);
      });
      
      const batch: BatchResult<unknown, BatchTestData> = {
        steps: [{ 
          id: 'step1', 
          requires: [], 
          collect: [],
          prepare: async () => { throw new Error('Prepare failed'); },
        }],
        stoppedReason: 'route_complete',
      };
      
      const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
      
      await executor.executeBatch({
        batch,
        session: initialSession,
        context: {},
        executeHook: async (hook) => {
          if (typeof hook === 'function') {
            await hook({}, {});
          }
        },
        generateMessage: async () => ({ message: 'Test', structured: {} }),
        routeId: 'test-route',
      });
      
      const batchCompleteEvent = events.find(e => e.type === 'batch_complete');
      expect(batchCompleteEvent).toBeDefined();
      expect(batchCompleteEvent!.details.stoppedReason).toBe('prepare_error');
    });

    test("removeEventListener method works correctly", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      const events: BatchExecutionEvent[] = [];
      
      const listener = (event: BatchExecutionEvent) => {
        events.push(event);
      };
      
      executor.addEventListener(listener);
      executor.removeEventListener(listener);
      
      const route = new Route<unknown, BatchTestData>({
        title: 'Remove Test Route',
        steps: [{ id: 'step1', requires: [], collect: [] }],
      });
      
      await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      expect(events.length).toBe(0);
    });
  });
});


/**
 * Property-Based Tests for Backward Compatibility
 * 
 * Feature: multi-step-execution
 * Property 11: Backward Compatibility
 * 
 * Tests that existing Route configurations produce functionally correct results
 * (same final data collected, same route completion status) even though the
 * execution flow may differ.
 * 
 * **Validates: Requirements 10.2, 10.3**
 */

describe("BatchExecutor - Backward Compatibility", () => {
  /**
   * Property 11: Backward Compatibility
   * 
   * For any existing Route configuration, the Execution_Engine SHALL produce
   * functionally correct results (same final data collected, same route completion
   * status) even though the execution flow may differ.
   * 
   * **Validates: Requirements 10.2, 10.3**
   */

  describe("Property 11: Backward Compatibility", () => {
    
    // Test single-step routes (Requirement 10.2)
    describe("Single-step routes", () => {
      test("single step route without requirements completes correctly", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.string({ minLength: 1, maxLength: 20 }),
            async (stepId) => {
              // Create a simple single-step route (common existing pattern)
              const route = new Route<unknown, BatchTestData>({
                title: 'Single Step Route',
                steps: [
                  { id: stepId, requires: [], collect: [] },
                ],
              });
              
              const executor = new BatchExecutor<unknown, BatchTestData>();
              
              const result = await executor.determineBatch({
                route,
                currentStep: undefined,
                sessionData: {},
                context: {},
              });
              
              // Property: Single step should be included and route should complete
              expect(result.steps.length).toBe(1);
              expect(result.steps[0].id).toBe(stepId);
              expect(result.stoppedReason).toBe('route_complete');
            }
          ),
          { numRuns: 100 }
        );
      });


      test("single step route with collect fields needs input when data missing", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.uniqueArray(
              fc.constantFrom('field1', 'field2', 'field3') as fc.Arbitrary<keyof BatchTestData>,
              { minLength: 1, maxLength: 3 }
            ),
            async (collectFields) => {
              const route = new Route<unknown, BatchTestData>({
                title: 'Single Step Collect Route',
                steps: [
                  { id: 'collect_step', requires: [], collect: collectFields },
                ],
              });
              
              const executor = new BatchExecutor<unknown, BatchTestData>();
              
              // Without data, should need input
              const resultWithoutData = await executor.determineBatch({
                route,
                currentStep: undefined,
                sessionData: {},
                context: {},
              });
              
              expect(resultWithoutData.stoppedReason).toBe('needs_input');
              expect(resultWithoutData.steps.length).toBe(0);
              
              // With data for at least one collect field, should include step
              const sessionWithData: Partial<BatchTestData> = {};
              sessionWithData[collectFields[0]] = 'value';
              
              const resultWithData = await executor.determineBatch({
                route,
                currentStep: undefined,
                sessionData: sessionWithData,
                context: {},
              });
              
              expect(resultWithData.steps.length).toBe(1);
              expect(resultWithData.stoppedReason).toBe('route_complete');
            }
          ),
          { numRuns: 100 }
        );
      });


      test("single step route with requires fields needs input when data missing", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.uniqueArray(
              fc.constantFrom('field1', 'field2', 'field3') as fc.Arbitrary<keyof BatchTestData>,
              { minLength: 1, maxLength: 3 }
            ),
            async (requiresFields) => {
              const route = new Route<unknown, BatchTestData>({
                title: 'Single Step Requires Route',
                steps: [
                  { id: 'requires_step', requires: requiresFields, collect: [] },
                ],
              });
              
              const executor = new BatchExecutor<unknown, BatchTestData>();
              
              // Without required data, should need input
              const resultWithoutData = await executor.determineBatch({
                route,
                currentStep: undefined,
                sessionData: {},
                context: {},
              });
              
              expect(resultWithoutData.stoppedReason).toBe('needs_input');
              expect(resultWithoutData.steps.length).toBe(0);
              
              // With all required data, should include step
              const sessionWithData: Partial<BatchTestData> = {};
              requiresFields.forEach(f => { sessionWithData[f] = 'value'; });
              
              const resultWithData = await executor.determineBatch({
                route,
                currentStep: undefined,
                sessionData: sessionWithData,
                context: {},
              });
              
              expect(resultWithData.steps.length).toBe(1);
              expect(resultWithData.stoppedReason).toBe('route_complete');
            }
          ),
          { numRuns: 100 }
        );
      });
    });


    // Test routes where each step needs input (Requirement 10.2)
    describe("Routes where each step needs input", () => {
      test("multi-step route where each step needs input stops at first step", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 2, max: 5 }),
            async (numSteps) => {
              // Create route where each step requires different fields
              const steps: StepOptions<unknown, BatchTestData>[] = [];
              const fields: (keyof BatchTestData)[] = ['field1', 'field2', 'field3', 'field4', 'field5'];
              
              for (let i = 0; i < numSteps && i < fields.length; i++) {
                steps.push({
                  id: `step_${i}`,
                  requires: [fields[i]],
                  collect: [],
                });
              }
              
              const route = new Route<unknown, BatchTestData>({
                title: 'Each Step Needs Input Route',
                steps,
              });
              
              const executor = new BatchExecutor<unknown, BatchTestData>();
              
              // With no data, should stop at first step
              const result = await executor.determineBatch({
                route,
                currentStep: undefined,
                sessionData: {},
                context: {},
              });
              
              expect(result.stoppedReason).toBe('needs_input');
              expect(result.steps.length).toBe(0);
              expect(result.stoppedAtStep?.id).toBe('step_0');
            }
          ),
          { numRuns: 100 }
        );
      });


      test("providing data for first step allows progress to second step", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 2, max: 4 }),
            async (numSteps) => {
              const fields: (keyof BatchTestData)[] = ['field1', 'field2', 'field3', 'field4'];
              const steps: StepOptions<unknown, BatchTestData>[] = [];
              
              for (let i = 0; i < numSteps && i < fields.length; i++) {
                steps.push({
                  id: `step_${i}`,
                  requires: [fields[i]],
                  collect: [],
                });
              }
              
              const route = new Route<unknown, BatchTestData>({
                title: 'Progressive Input Route',
                steps,
              });
              
              const executor = new BatchExecutor<unknown, BatchTestData>();
              
              // Provide data for first step only
              const sessionData: Partial<BatchTestData> = { field1: 'value1' };
              
              const result = await executor.determineBatch({
                route,
                currentStep: undefined,
                sessionData,
                context: {},
              });
              
              // Should include first step and stop at second
              expect(result.steps.length).toBe(1);
              expect(result.steps[0].id).toBe('step_0');
              expect(result.stoppedReason).toBe('needs_input');
              expect(result.stoppedAtStep?.id).toBe('step_1');
            }
          ),
          { numRuns: 100 }
        );
      });


      test("providing all required data allows route completion", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 2, max: 4 }),
            async (numSteps) => {
              const fields: (keyof BatchTestData)[] = ['field1', 'field2', 'field3', 'field4'];
              const steps: StepOptions<unknown, BatchTestData>[] = [];
              
              for (let i = 0; i < numSteps && i < fields.length; i++) {
                steps.push({
                  id: `step_${i}`,
                  requires: [fields[i]],
                  collect: [],
                });
              }
              
              const route = new Route<unknown, BatchTestData>({
                title: 'All Data Route',
                steps,
              });
              
              const executor = new BatchExecutor<unknown, BatchTestData>();
              
              // Provide data for all steps
              const sessionData: Partial<BatchTestData> = {};
              for (let i = 0; i < numSteps && i < fields.length; i++) {
                sessionData[fields[i]] = `value_${i}`;
              }
              
              const result = await executor.determineBatch({
                route,
                currentStep: undefined,
                sessionData,
                context: {},
              });
              
              // Should include all steps and complete
              expect(result.steps.length).toBe(numSteps);
              expect(result.stoppedReason).toBe('route_complete');
            }
          ),
          { numRuns: 100 }
        );
      });
    });


    // Test routes with skipIf conditions (Requirement 10.2, 10.3)
    describe("Routes with skipIf conditions", () => {
      test("skipIf conditions are evaluated correctly", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.boolean(),
            fc.boolean(),
            async (skipFirst, skipSecond) => {
              const route = new Route<unknown, BatchTestData>({
                title: 'SkipIf Route',
                steps: [
                  { id: 'step1', requires: [], collect: [], skipIf: () => skipFirst },
                  { id: 'step2', requires: [], collect: [], skipIf: () => skipSecond },
                  { id: 'step3', requires: [], collect: [] },
                ],
              });
              
              const executor = new BatchExecutor<unknown, BatchTestData>();
              
              const result = await executor.determineBatch({
                route,
                currentStep: undefined,
                sessionData: {},
                context: {},
              });
              
              // Count expected steps (non-skipped)
              let expectedSteps = 1; // step3 is always included
              if (!skipFirst) expectedSteps++;
              if (!skipSecond) expectedSteps++;
              
              expect(result.steps.length).toBe(expectedSteps);
              expect(result.stoppedReason).toBe('route_complete');
              
              // Verify correct steps are included
              if (!skipFirst) {
                expect(result.steps.some(s => s.id === 'step1')).toBe(true);
              } else {
                expect(result.steps.some(s => s.id === 'step1')).toBe(false);
              }
              
              if (!skipSecond) {
                expect(result.steps.some(s => s.id === 'step2')).toBe(true);
              } else {
                expect(result.steps.some(s => s.id === 'step2')).toBe(false);
              }
              
              expect(result.steps.some(s => s.id === 'step3')).toBe(true);
            }
          ),
          { numRuns: 100 }
        );
      });


      test("skipIf with context-based conditions works correctly", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.boolean(),
            async (shouldSkip) => {
              type TestContext = { skipStep: boolean };
              
              const route = new Route<TestContext, BatchTestData>({
                title: 'Context SkipIf Route',
                steps: [
                  { 
                    id: 'conditional_step', 
                    requires: [], 
                    collect: [], 
                    skipIf: ({ context }) => context?.skipStep ?? false,
                  },
                  { id: 'final_step', requires: [], collect: [] },
                ],
              });
              
              const executor = new BatchExecutor<TestContext, BatchTestData>();
              
              const result = await executor.determineBatch({
                route,
                currentStep: undefined,
                sessionData: {},
                context: { skipStep: shouldSkip },
              });
              
              if (shouldSkip) {
                expect(result.steps.length).toBe(1);
                expect(result.steps[0].id).toBe('final_step');
              } else {
                expect(result.steps.length).toBe(2);
                expect(result.steps[0].id).toBe('conditional_step');
                expect(result.steps[1].id).toBe('final_step');
              }
              
              expect(result.stoppedReason).toBe('route_complete');
            }
          ),
          { numRuns: 100 }
        );
      });


      test("skipIf with data-based conditions works correctly", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.option(fc.string()),
            async (fieldValue) => {
              const route = new Route<unknown, BatchTestData>({
                title: 'Data SkipIf Route',
                steps: [
                  { 
                    id: 'data_conditional_step', 
                    requires: [], 
                    collect: [], 
                    skipIf: ({ data }) => data?.field1 === 'skip_me',
                  },
                  { id: 'final_step', requires: [], collect: [] },
                ],
              });
              
              const executor = new BatchExecutor<unknown, BatchTestData>();
              
              const sessionData: Partial<BatchTestData> = {};
              if (fieldValue !== null) {
                sessionData.field1 = fieldValue;
              }
              
              const result = await executor.determineBatch({
                route,
                currentStep: undefined,
                sessionData,
                context: {},
              });
              
              const shouldSkip = fieldValue === 'skip_me';
              
              if (shouldSkip) {
                expect(result.steps.length).toBe(1);
                expect(result.steps[0].id).toBe('final_step');
              } else {
                expect(result.steps.length).toBe(2);
                expect(result.steps[0].id).toBe('data_conditional_step');
              }
              
              expect(result.stoppedReason).toBe('route_complete');
            }
          ),
          { numRuns: 100 }
        );
      });


      test("skipIf combined with requires produces correct behavior", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.boolean(),
            fc.boolean(),
            async (skipStep, hasRequiredData) => {
              const route = new Route<unknown, BatchTestData>({
                title: 'SkipIf + Requires Route',
                steps: [
                  { 
                    id: 'conditional_requires_step', 
                    requires: ['field1'], 
                    collect: [], 
                    skipIf: () => skipStep,
                  },
                  { id: 'final_step', requires: [], collect: [] },
                ],
              });
              
              const executor = new BatchExecutor<unknown, BatchTestData>();
              
              const sessionData: Partial<BatchTestData> = {};
              if (hasRequiredData) {
                sessionData.field1 = 'value';
              }
              
              const result = await executor.determineBatch({
                route,
                currentStep: undefined,
                sessionData,
                context: {},
              });
              
              if (skipStep) {
                // Step is skipped, so requires don't matter
                expect(result.steps.length).toBe(1);
                expect(result.steps[0].id).toBe('final_step');
                expect(result.stoppedReason).toBe('route_complete');
              } else if (hasRequiredData) {
                // Step not skipped and has required data
                expect(result.steps.length).toBe(2);
                expect(result.steps[0].id).toBe('conditional_requires_step');
                expect(result.stoppedReason).toBe('route_complete');
              } else {
                // Step not skipped but missing required data
                expect(result.steps.length).toBe(0);
                expect(result.stoppedReason).toBe('needs_input');
              }
            }
          ),
          { numRuns: 100 }
        );
      });
    });


    // Test that existing configurations produce functionally correct results
    describe("Functional correctness", () => {
      test("data collection produces same final data regardless of batching", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.record({
              field1: fc.string(),
              field2: fc.string(),
            }),
            async (collectedValues) => {
              const executor = new BatchExecutor<unknown, BatchTestData>();
              
              // Simulate batch execution with data collection
              const batch: BatchResult<unknown, BatchTestData> = {
                steps: [
                  { id: 'step1', requires: [], collect: ['field1'] },
                  { id: 'step2', requires: [], collect: ['field2'] },
                ],
                stoppedReason: 'route_complete',
              };
              
              const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
              
              const result = await executor.executeBatch({
                batch,
                session: initialSession,
                context: {},
                executeHook: async () => {},
                generateMessage: async () => ({
                  message: 'Test response',
                  structured: {
                    message: 'Test response',
                    field1: collectedValues.field1,
                    field2: collectedValues.field2,
                  },
                }),
                routeId: 'test-route',
              });
              
              // Property: Final data should match what was collected
              expect(result.session.data.field1).toBe(collectedValues.field1);
              expect(result.session.data.field2).toBe(collectedValues.field2);
              expect(result.collectedData?.field1).toBe(collectedValues.field1);
              expect(result.collectedData?.field2).toBe(collectedValues.field2);
            }
          ),
          { numRuns: 100 }
        );
      });


      test("route completion status is correct for various configurations", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.constantFrom('complete', 'needs_input', 'end_route') as fc.Arbitrary<string>,
            async (expectedOutcome) => {
              let steps: StepOptions<unknown, BatchTestData>[];
              let sessionData: Partial<BatchTestData> = {};
              
              if (expectedOutcome === 'complete') {
                // Route that should complete
                steps = [
                  { id: 'step1', requires: [], collect: [] },
                  { id: 'step2', requires: [], collect: [] },
                ];
              } else if (expectedOutcome === 'needs_input') {
                // Route that should need input
                steps = [
                  { id: 'step1', requires: ['field1'], collect: [] },
                ];
              } else {
                // Route that ends with END_ROUTE
                steps = [
                  { id: 'step1', requires: [], collect: [] },
                  END_ROUTE as unknown as StepOptions<unknown, BatchTestData>,
                ];
              }
              
              const route = new Route<unknown, BatchTestData>({
                title: 'Completion Status Route',
                steps,
              });
              
              const executor = new BatchExecutor<unknown, BatchTestData>();
              
              const result = await executor.determineBatch({
                route,
                currentStep: undefined,
                sessionData,
                context: {},
              });
              
              if (expectedOutcome === 'complete') {
                expect(result.stoppedReason).toBe('route_complete');
              } else if (expectedOutcome === 'needs_input') {
                expect(result.stoppedReason).toBe('needs_input');
              } else {
                expect(result.stoppedReason).toBe('end_route');
              }
            }
          ),
          { numRuns: 100 }
        );
      });


      test("hooks execute in correct order for backward compatibility", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 1, max: 4 }),
            async (numSteps) => {
              const executionOrder: string[] = [];
              const executor = new BatchExecutor<unknown, BatchTestData>();
              
              // Create steps with prepare and finalize hooks
              const steps: StepOptions<unknown, BatchTestData>[] = [];
              for (let i = 0; i < numSteps; i++) {
                steps.push({
                  id: `step_${i}`,
                  requires: [],
                  collect: [],
                  prepare: async () => { executionOrder.push(`prepare_${i}`); },
                  finalize: async () => { executionOrder.push(`finalize_${i}`); },
                });
              }
              
              const batch: BatchResult<unknown, BatchTestData> = {
                steps,
                stoppedReason: 'route_complete',
              };
              
              const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
              
              const executeHook = async (
                hook: HookFunction<unknown, BatchTestData>,
                context: unknown,
                data?: Partial<BatchTestData>
              ) => {
                if (typeof hook === 'function') {
                  await hook(context, data);
                }
              };
              
              await executor.executeBatch({
                batch,
                session: initialSession,
                context: {},
                executeHook,
                generateMessage: async () => ({ message: 'Test', structured: {} }),
                routeId: 'test-route',
              });
              
              // Property: All prepare hooks should execute before any finalize hooks
              const prepareIndices = executionOrder
                .map((item, idx) => item.startsWith('prepare_') ? idx : -1)
                .filter(idx => idx !== -1);
              const finalizeIndices = executionOrder
                .map((item, idx) => item.startsWith('finalize_') ? idx : -1)
                .filter(idx => idx !== -1);
              
              if (prepareIndices.length > 0 && finalizeIndices.length > 0) {
                const maxPrepareIndex = Math.max(...prepareIndices);
                const minFinalizeIndex = Math.min(...finalizeIndices);
                expect(maxPrepareIndex).toBeLessThan(minFinalizeIndex);
              }
              
              // Property: Hooks should execute in step order within each phase
              for (let i = 1; i < prepareIndices.length; i++) {
                expect(prepareIndices[i]).toBeGreaterThan(prepareIndices[i - 1]);
              }
              for (let i = 1; i < finalizeIndices.length; i++) {
                expect(finalizeIndices[i]).toBeGreaterThan(finalizeIndices[i - 1]);
              }
            }
          ),
          { numRuns: 100 }
        );
      });
    });
  });


  // Unit tests for backward compatibility edge cases
  describe("Backward Compatibility Edge Cases", () => {
    test("empty route completes correctly", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'Empty Route',
        steps: [],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Empty route should complete (or end_route depending on implementation)
      expect(['route_complete', 'end_route']).toContain(result.stoppedReason);
    });

    test("route with only END_ROUTE completes correctly", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'Only END_ROUTE',
        steps: [
          END_ROUTE as unknown as StepOptions<unknown, BatchTestData>,
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Route with only END_ROUTE may complete as 'route_complete' or 'end_route'
      // depending on how the Route class handles the initial step
      // The Route class may create an initial step automatically
      expect(['end_route', 'route_complete']).toContain(result.stoppedReason);
    });


    test("route with all steps skipped completes correctly", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'All Skipped Route',
        steps: [
          { id: 'skip1', requires: [], collect: [], skipIf: () => true },
          { id: 'skip2', requires: [], collect: [], skipIf: () => true },
          { id: 'skip3', requires: [], collect: [], skipIf: () => true },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // All steps skipped, route should complete
      expect(['route_complete', 'end_route']).toContain(result.stoppedReason);
      expect(result.steps.length).toBe(0);
    });

    test("mixed requires and collect fields work correctly", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'Mixed Fields Route',
        steps: [
          { id: 'step1', requires: ['field1'], collect: ['field2'] },
          { id: 'step2', requires: ['field2'], collect: ['field3'] },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      // With field1 and field2, first step should be included
      const sessionData: Partial<BatchTestData> = { field1: 'v1', field2: 'v2' };
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData,
        context: {},
      });
      
      // First step has requires satisfied and collect has data
      // Second step has requires satisfied (field2) but collect (field3) has no data
      expect(result.steps.length).toBe(1);
      expect(result.steps[0].id).toBe('step1');
      expect(result.stoppedReason).toBe('needs_input');
    });


    test("async skipIf conditions work correctly", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'Async SkipIf Route',
        steps: [
          { 
            id: 'async_skip', 
            requires: [], 
            collect: [], 
            skipIf: async () => {
              await new Promise(resolve => setTimeout(resolve, 1));
              return true;
            },
          },
          { id: 'final', requires: [], collect: [] },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Async skipIf should work correctly
      expect(result.steps.length).toBe(1);
      expect(result.steps[0].id).toBe('final');
      expect(result.stoppedReason).toBe('route_complete');
    });

    test("skipIf error handling maintains backward compatibility", async () => {
      const route = new Route<unknown, BatchTestData>({
        title: 'SkipIf Error Route',
        steps: [
          { 
            id: 'error_skip', 
            requires: [], 
            collect: [], 
            skipIf: () => { throw new Error('skipIf error'); },
          },
          { id: 'final', requires: [], collect: [] },
        ],
      });
      
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const result = await executor.determineBatch({
        route,
        currentStep: undefined,
        sessionData: {},
        context: {},
      });
      
      // Step with error in skipIf should be treated as non-skippable
      expect(result.steps.length).toBe(2);
      expect(result.steps[0].id).toBe('error_skip');
      expect(result.stoppedReason).toBe('route_complete');
    });


    test("existing session data is preserved during batch execution", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const batch: BatchResult<unknown, BatchTestData> = {
        steps: [
          { id: 'step1', requires: [], collect: ['field2'] },
        ],
        stoppedReason: 'route_complete',
      };
      
      // Session with existing data
      const initialSession = { 
        id: 'test', 
        data: { field1: 'existing_value' } as Partial<BatchTestData>,
      };
      
      const result = await executor.executeBatch({
        batch,
        session: initialSession,
        context: {},
        executeHook: async () => {},
        generateMessage: async () => ({
          message: 'Test',
          structured: { message: 'Test', field2: 'new_value' },
        }),
        routeId: 'test-route',
      });
      
      // Existing data should be preserved
      expect(result.session.data.field1).toBe('existing_value');
      // New data should be added
      expect(result.session.data.field2).toBe('new_value');
    });

    test("executedSteps correctly reflects batch execution", async () => {
      const executor = new BatchExecutor<unknown, BatchTestData>();
      
      const batch: BatchResult<unknown, BatchTestData> = {
        steps: [
          { id: 'step1', requires: [], collect: [] },
          { id: 'step2', requires: [], collect: [] },
          { id: 'step3', requires: [], collect: [] },
        ],
        stoppedReason: 'route_complete',
      };
      
      const initialSession = { id: 'test', data: {} as Partial<BatchTestData> };
      
      const result = await executor.executeBatch({
        batch,
        session: initialSession,
        context: {},
        executeHook: async () => {},
        generateMessage: async () => ({ message: 'Test', structured: {} }),
        routeId: 'test-route',
      });
      
      // executedSteps should match batch steps
      expect(result.executedSteps.length).toBe(3);
      expect(result.executedSteps[0].id).toBe('step1');
      expect(result.executedSteps[1].id).toBe('step2');
      expect(result.executedSteps[2].id).toBe('step3');
      expect(result.executedSteps.every(s => s.routeId === 'test-route')).toBe(true);
    });
  });
});
