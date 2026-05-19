/**
 * Persistence v2 tests — round-trip correctness for pendingDirective, signals,
 * PreDirective field stripping, and legacy field handling.
 *
 * Tests persistence through shared utils (`createPersistedState`,
 * `sessionStepToData`, `sessionDataToStep`) and MemoryAdapter.
 *
 * **Validates: Requirements 12.1–12.6, 13.4, 19.1–19.6, 24.5**
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
    createPersistedState,
    sessionStepToData,
    sessionDataToStep,
} from "../src/utils/session";
import { MemoryAdapter } from "../src/adapters/MemoryAdapter";
import type { SessionState, SignalsState } from "../src/types/session";
import type { Directive } from "../src/types/flow";
import type { CollectedStateData } from "../src/types/persistence";

// ─── Test data types ─────────────────────────────────────────────────────────

interface TestData {
    name?: string;
    email?: string;
    plan?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(
    overrides?: Partial<SessionState<TestData>>
): SessionState<TestData> {
    return {
        id: "sess_test_1",
        data: { name: "Alice" },
        flowHistory: [{ flowId: "onboarding", enteredAt: new Date(), completed: false }],
        currentFlow: { id: "onboarding", title: "Onboarding Flow" },
        currentStep: { id: "ask_name", description: "Ask name" },
        history: [],
        metadata: { createdAt: new Date(), lastUpdatedAt: new Date() },
        ...overrides,
    };
}

function makeSyntheticSignals(): SignalsState {
    return {
        triggers: {
            frustration: {
                firstTriggeredAt: new Date("2025-01-01T10:00:00Z"),
                lastTriggeredAt: new Date("2025-01-01T12:30:00Z"),
                count: 3,
                lastReason: "repeated complaints",
                lastPhase: "post",
            },
            escalation: {
                firstTriggeredAt: new Date("2025-01-01T11:00:00Z"),
                lastTriggeredAt: new Date("2025-01-01T11:00:00Z"),
                count: 1,
                lastPhase: "pre",
            },
        },
    };
}

// ─── Round-trip: pendingDirective ────────────────────────────────────────────

describe("Round-trip: pendingDirective", () => {
    test("write a session with pendingDirective set, reload via sessionStepToData/sessionDataToStep, assert directive intact", () => {
        /**
         * Validates: Requirements 12.1, 12.2, 12.5, 19.1
         */
        const directive: Directive<unknown, TestData> = {
            goTo: "Billing",
            reply: "Let me transfer you to billing.",
            dataUpdate: { plan: "premium" },
        };

        const session = makeSession({ pendingDirective: directive });

        // Persist via sessionStepToData
        const persisted = sessionStepToData(session);

        // Verify pendingDirective is present in collectedData
        expect(persisted.collectedData.pendingDirective).toEqual(directive);

        // Reload via sessionDataToStep
        const loaded = sessionDataToStep<TestData>(session.id, persisted);

        expect(loaded.pendingDirective).toEqual(directive);
        expect(loaded.pendingDirective!.goTo).toBe("Billing");
        expect(loaded.pendingDirective!.reply).toBe("Let me transfer you to billing.");
        expect(loaded.pendingDirective!.dataUpdate).toEqual({ plan: "premium" });
    });

    test("round-trip via createPersistedState preserves pendingDirective intact", () => {
        /**
         * Validates: Requirements 12.1, 12.5
         */
        const directive: Directive<unknown, TestData> = {
            goToStep: "verify_email",
            contextUpdate: { source: "api" },
        };

        const session = makeSession({ pendingDirective: directive });
        const persisted = createPersistedState(session);

        expect(persisted.pendingDirective).toEqual(directive);
    });

    test("round-trip through MemoryAdapter preserves pendingDirective", async () => {
        /**
         * Validates: Requirements 12.1, 12.5, 19.1
         */
        const adapter = new MemoryAdapter<TestData>();
        const directive: Directive<unknown, TestData> = {
            goTo: { flow: "Support", step: "initial", reason: "escalation" },
            dataUpdate: { name: "Bob" },
        };

        const session = makeSession({ pendingDirective: directive });
        const { collectedData, currentFlow, currentStep } = sessionStepToData(session);

        // Save through adapter
        const saved = await adapter.sessionRepository.create({
            userId: "user_1",
            status: "active",
            currentFlow,
            currentStep,
            collectedData,
        });

        // Load through adapter
        const loaded = await adapter.sessionRepository.findById(saved.id);
        expect(loaded).not.toBeNull();
        expect(loaded!.collectedData!.pendingDirective).toEqual(directive);

        // Full reload via sessionDataToStep
        const reloaded = sessionDataToStep<TestData>(saved.id, {
            currentFlow: loaded!.currentFlow,
            currentStep: loaded!.currentStep,
            collectedData: loaded!.collectedData,
        });

        expect(reloaded.pendingDirective).toEqual(directive);
    });
});

// ─── Round-trip: signals ─────────────────────────────────────────────────────

describe("Round-trip: signals (bit-identical)", () => {
    test("write a session with signals set, reload via sessionStepToData/sessionDataToStep, assert bit-identical", () => {
        /**
         * Validates: Requirements 13.4, 19.2, 19.3
         */
        const signals = makeSyntheticSignals();
        const session = makeSession({ signals });

        // Persist
        const persisted = sessionStepToData(session);

        // Verify signals passed through
        expect(persisted.collectedData.signals).toEqual(signals);

        // Reload
        const loaded = sessionDataToStep<TestData>(session.id, persisted);

        // Assert bit-identical (structural equality)
        expect(loaded.signals).toEqual(signals);
        expect(loaded.signals!.triggers.frustration.count).toBe(3);
        expect(loaded.signals!.triggers.frustration.lastReason).toBe("repeated complaints");
        expect(loaded.signals!.triggers.frustration.lastPhase).toBe("post");
        expect(loaded.signals!.triggers.escalation.count).toBe(1);
        expect(loaded.signals!.triggers.escalation.lastPhase).toBe("pre");
        expect(loaded.signals!.triggers.escalation.lastReason).toBeUndefined();
    });

    test("round-trip via createPersistedState preserves signals bit-identical", () => {
        /**
         * Validates: Requirements 13.4, 19.2
         */
        const signals = makeSyntheticSignals();
        const session = makeSession({ signals });

        const persisted = createPersistedState(session);
        expect(persisted.signals).toEqual(signals);
    });

    test("round-trip through MemoryAdapter preserves signals bit-identical", async () => {
        /**
         * Validates: Requirements 13.4, 19.3, 19.6
         */
        const adapter = new MemoryAdapter<TestData>();
        const signals = makeSyntheticSignals();
        const session = makeSession({ signals });
        const { collectedData, currentFlow, currentStep } = sessionStepToData(session);

        const saved = await adapter.sessionRepository.create({
            userId: "user_2",
            status: "active",
            currentFlow,
            currentStep,
            collectedData,
        });

        const loaded = await adapter.sessionRepository.findById(saved.id);
        expect(loaded!.collectedData!.signals).toEqual(signals);

        // Full reload
        const reloaded = sessionDataToStep<TestData>(saved.id, {
            currentFlow: loaded!.currentFlow,
            currentStep: loaded!.currentStep,
            collectedData: loaded!.collectedData,
        });

        expect(reloaded.signals).toEqual(signals);
        expect(reloaded.signals!.triggers.frustration).toEqual(signals.triggers.frustration);
        expect(reloaded.signals!.triggers.escalation).toEqual(signals.triggers.escalation);
    });

    test("session with no signals does not produce a signals key after round-trip", () => {
        /**
         * Validates: Requirements 19.2 (omit when undefined)
         */
        const session = makeSession({ signals: undefined });

        const persisted = createPersistedState(session);
        expect("signals" in persisted).toBe(false);

        const { collectedData } = sessionStepToData(session);
        expect("signals" in collectedData).toBe(false);
    });
});

// ─── Pre-LLM-only fields stripped before persist ─────────────────────────────

describe("Pre-LLM-only fields stripped before persist", () => {
    test("sessionStepToData strips appendPrompt/injectTools/halt from pendingDirective", () => {
        /**
         * Validates: Requirements 12.6, 24.5
         */
        const fakeTool = { id: "lookup", description: "Lookup tool", parameters: {}, handler: () => ({}) };
        const session = makeSession({
            pendingDirective: {
                goTo: "Help",
                reply: "Redirecting...",
                appendPrompt: ["Be concise"],
                injectTools: [fakeTool],
                halt: true,
            } as any,
        });

        const persisted = sessionStepToData(session);

        // Only Directive fields should survive
        expect(persisted.collectedData.pendingDirective).toEqual({
            goTo: "Help",
            reply: "Redirecting...",
        });
        expect("appendPrompt" in (persisted.collectedData.pendingDirective as any)).toBe(false);
        expect("injectTools" in (persisted.collectedData.pendingDirective as any)).toBe(false);
        expect("halt" in (persisted.collectedData.pendingDirective as any)).toBe(false);
    });

    test("createPersistedState strips appendPrompt/injectTools/halt from pendingDirective", () => {
        /**
         * Validates: Requirements 12.6, 24.5
         */
        const session = makeSession({
            pendingDirective: {
                complete: true,
                appendPrompt: ["Extra context"],
                halt: true,
            } as any,
        });

        const persisted = createPersistedState(session);

        expect(persisted.pendingDirective).toEqual({ complete: true });
        expect("appendPrompt" in (persisted.pendingDirective as any)).toBe(false);
        expect("halt" in (persisted.pendingDirective as any)).toBe(false);
    });

    test("full round-trip: PreDirective fields never land in reloaded session", () => {
        /**
         * Validates: Requirements 12.6, 24.5
         */
        const session = makeSession({
            pendingDirective: {
                goToStep: "confirm",
                dataUpdate: { email: "a@b.com" },
                appendPrompt: ["Urgent"],
                injectTools: [{ id: "t", description: "t", parameters: {}, handler: () => ({}) }],
                halt: true,
            } as any,
        });

        const persisted = sessionStepToData(session);
        const loaded = sessionDataToStep<TestData>(session.id, persisted);

        expect(loaded.pendingDirective).toEqual({
            goToStep: "confirm",
            dataUpdate: { email: "a@b.com" },
        });
        // Verify no PreDirective fields exist
        const raw = loaded.pendingDirective as any;
        expect(raw.appendPrompt).toBeUndefined();
        expect(raw.injectTools).toBeUndefined();
        expect(raw.halt).toBeUndefined();
    });
});

// ─── Legacy pendingTransition handling ───────────────────────────────────────

describe("Legacy pendingTransition handling", () => {
    test("legacy pendingTransition with no pendingDirective → load yields pendingDirective: undefined", () => {
        /**
         * Validates: Requirements 12.3, 12.4
         *
         * v2 ignores legacy pendingTransition entirely. If a v1 persisted record
         * has only pendingTransition (no pendingDirective), loading it yields no
         * pendingDirective on the session.
         */
        const legacyCollectedData: CollectedStateData<TestData> = {
            data: { name: "Legacy User" },
            flowHistory: [],
            metadata: {},
            // Simulate a v1 record that has pendingTransition but no pendingDirective
            // (The field doesn't exist on the type, but may exist on stored JSON)
        };

        // Simulate legacy data where pendingTransition was set
        (legacyCollectedData as any).pendingTransition = {
            targetFlow: "OldFlow",
            targetStep: "old_step",
        };

        const loaded = sessionDataToStep<TestData>("legacy_session_1", {
            currentFlow: "some_flow",
            currentStep: "some_step",
            collectedData: legacyCollectedData,
        });

        // v2 ignores pendingTransition — no migration, no pendingDirective produced
        expect(loaded.pendingDirective).toBeUndefined();
        // The legacy field should NOT bleed through to the session
        expect("pendingTransition" in loaded).toBe(false);
    });

    test("legacy pendingTransition alongside pendingDirective → only pendingDirective honored", () => {
        /**
         * Validates: Requirements 12.3, 12.4
         */
        const directive: Directive<unknown, TestData> = { goTo: "NewFlow" };
        const collectedData: CollectedStateData<TestData> = {
            data: { name: "Mixed" },
            flowHistory: [],
            metadata: {},
            pendingDirective: directive,
        };

        // Add legacy field
        (collectedData as any).pendingTransition = {
            targetFlow: "OldFlow",
        };

        const loaded = sessionDataToStep<TestData>("mixed_session", {
            currentFlow: "active",
            currentStep: "step_1",
            collectedData,
        });

        expect(loaded.pendingDirective).toEqual(directive);
        expect("pendingTransition" in loaded).toBe(false);
    });
});

// ─── pendingDirective: undefined → adapter omits the key ─────────────────────

describe("pendingDirective: undefined → adapter omits the key", () => {
    test("createPersistedState omits pendingDirective key when undefined", () => {
        /**
         * Validates: Requirement 12.5
         */
        const session = makeSession({ pendingDirective: undefined });
        const persisted = createPersistedState(session);

        expect("pendingDirective" in persisted).toBe(false);
    });

    test("sessionStepToData omits pendingDirective from collectedData when undefined", () => {
        /**
         * Validates: Requirement 12.5
         */
        const session = makeSession({ pendingDirective: undefined });
        const { collectedData } = sessionStepToData(session);

        expect("pendingDirective" in collectedData).toBe(false);
    });

    test("MemoryAdapter does not store pendingDirective as null when session has no directive", async () => {
        /**
         * Validates: Requirements 12.5, 19.1
         */
        const adapter = new MemoryAdapter<TestData>();
        const session = makeSession({ pendingDirective: undefined });
        const { collectedData, currentFlow, currentStep } = sessionStepToData(session);

        const saved = await adapter.sessionRepository.create({
            userId: "user_3",
            status: "active",
            currentFlow,
            currentStep,
            collectedData,
        });

        const loaded = await adapter.sessionRepository.findById(saved.id);

        // The collectedData should not have the pendingDirective key at all
        expect("pendingDirective" in (loaded!.collectedData ?? {})).toBe(false);
    });
});

// ─── Combined round-trip: pendingDirective + signals together ────────────────

describe("Combined: pendingDirective + signals together", () => {
    test("both pendingDirective and signals survive round-trip via MemoryAdapter", async () => {
        /**
         * Validates: Requirements 12.1, 12.5, 13.4, 19.1, 19.2, 19.3
         */
        const adapter = new MemoryAdapter<TestData>();
        const directive: Directive<unknown, TestData> = {
            goTo: "Checkout",
            dataUpdate: { plan: "enterprise" },
        };
        const signals = makeSyntheticSignals();

        const session = makeSession({ pendingDirective: directive, signals });
        const { collectedData, currentFlow, currentStep } = sessionStepToData(session);

        const saved = await adapter.sessionRepository.create({
            userId: "user_combined",
            status: "active",
            currentFlow,
            currentStep,
            collectedData,
        });

        const loaded = await adapter.sessionRepository.findById(saved.id);
        const reloaded = sessionDataToStep<TestData>(saved.id, {
            currentFlow: loaded!.currentFlow,
            currentStep: loaded!.currentStep,
            collectedData: loaded!.collectedData,
        });

        expect(reloaded.pendingDirective).toEqual(directive);
        expect(reloaded.signals).toEqual(signals);
    });
});
