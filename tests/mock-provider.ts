/**
 * Mock AI Provider for Testing
 *
 * Implements the AiProvider interface to provide predictable responses
 * for testing the falai framework without external API dependencies.
 */

import type {
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
  GenerateMessageStreamChunk,
  AgentStructuredResponse,
} from "../src/types/ai";

/**
 * Mock AI Provider Configuration
 */
export interface MockProviderConfig {
  /** Fixed response message to return */
  responseMessage?: string;
  /** Whether to simulate streaming */
  supportsStreaming?: boolean;
  /** Simulated response delay in milliseconds */
  delayMs?: number;
  /** Whether to throw errors for testing error handling */
  shouldThrowError?: boolean;
  /** Error message to throw when shouldThrowError is true */
  errorMessage?: string;
  /** Custom structured response data */
  structuredResponse?: AgentStructuredResponse;
  /** Model name to report */
  modelName?: string;
}

/**
 * Default mock responses for different scenarios
 */
export const MOCK_RESPONSES = {
  GREETING: "Hello! How can I help you today?",
  ACKNOWLEDGEMENT: "I understand. Let me help you with that.",
  QUESTION: "Could you provide more details about your request?",
  CONFIRMATION:
    "Thank you for the information. Is there anything else I can assist you with?",
  COMPLETION: "I've completed the task you requested.",
} as const;

/**
 * Mock AI Provider Implementation
 *
 * Provides predictable, configurable responses for testing purposes.
 */
export class MockProvider implements AiProvider {
  public readonly name = "MockProvider";

  private config: Required<MockProviderConfig>;

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      responseMessage: MOCK_RESPONSES.GREETING,
      supportsStreaming: true,
      delayMs: 10,
      shouldThrowError: false,
      errorMessage: "Mock provider error for testing",
      structuredResponse: {
        message: MOCK_RESPONSES.GREETING,
        route: null,
        step: null,
      },
      modelName: "mock-model-v1",
      ...config,
    };
  }

  /**
   * Generate a message response
   */
  async generateMessage<
    TContext = unknown,
    TStructured = AgentStructuredResponse
  >(
    _input: GenerateMessageInput<TContext>
  ): Promise<GenerateMessageOutput<TStructured>> {
    // Simulate API delay
    if (this.config.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.delayMs));
    }

    // Simulate error conditions
    if (this.config.shouldThrowError) {
      throw new Error(this.config.errorMessage);
    }

    return {
      message: this.config.responseMessage,
      metadata: {
        model: this.config.modelName,
        tokensUsed: 150,
        finishReason: "stop",
      },
      structured: this.config.structuredResponse as TStructured,
    };
  }

  /**
   * Generate a streaming message response
   */
  async *generateMessageStream<
    TContext = unknown,
    TStructured = AgentStructuredResponse
  >(
    _input: GenerateMessageInput<TContext>
  ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
    // Simulate error conditions
    if (this.config.shouldThrowError) {
      throw new Error(this.config.errorMessage);
    }

    const words = this.config.responseMessage.split(" ");
    let accumulated = "";

    for (let i = 0; i < words.length; i++) {
      // Simulate streaming delay
      if (this.config.delayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.config.delayMs)
        );
      }

      const word = words[i];
      const delta = (i === 0 ? "" : " ") + word;
      accumulated += delta;

      const chunk: GenerateMessageStreamChunk<TStructured> = {
        delta,
        accumulated,
        done: i === words.length - 1,
        metadata: {
          model: this.config.modelName,
          tokensUsed: accumulated.split(" ").length * 3,
          finishReason: i === words.length - 1 ? "stop" : undefined,
        },
      };

      // Add structured data on the final chunk
      if (chunk.done) {
        chunk.structured = this.config.structuredResponse as TStructured;
      }

      yield chunk;
    }
  }

  /**
   * Update the mock configuration
   */
  updateConfig(config: Partial<MockProviderConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<MockProviderConfig> {
    return { ...this.config };
  }

  /**
   * Reset to default configuration
   */
  reset(): void {
    this.config = {
      responseMessage: MOCK_RESPONSES.GREETING,
      supportsStreaming: true,
      delayMs: 10,
      shouldThrowError: false,
      errorMessage: "Mock provider error for testing",
      structuredResponse: {
        message: MOCK_RESPONSES.GREETING,
        route: null,
        step: null,
      },
      modelName: "mock-model-v1",
    };
  }
}

/**
 * Factory functions for common mock provider configurations
 */
export const MockProviderFactory = {
  /**
   * Create a basic mock provider
   */
  basic(): MockProvider {
    return new MockProvider();
  },

  /**
   * Create a mock provider that returns specific responses
   */
  withResponse(
    message: string,
    structured?: AgentStructuredResponse
  ): MockProvider {
    return new MockProvider({
      responseMessage: message,
      structuredResponse: structured || {
        message,
        route: null,
        step: null,
      },
    });
  },

  /**
   * Create a mock provider that throws errors
   */
  withError(errorMessage = "Mock error"): MockProvider {
    return new MockProvider({
      shouldThrowError: true,
      errorMessage: errorMessage,
      responseMessage: errorMessage,
    });
  },

  /**
   * Create a mock provider with slow responses
   */
  slow(delayMs = 100): MockProvider {
    return new MockProvider({ delayMs });
  },

  /**
   * Create a mock provider for route testing
   */
  forRoute(routeName: string, stepName?: string): MockProvider {
    return new MockProvider({
      responseMessage: `I'll help you with the ${routeName} process.`,
      structuredResponse: {
        message: `I'll help you with the ${routeName} process.`,
        route: routeName,
        step: stepName || null,
      },
    });
  },

  /**
   * Create a mock provider that simulates tool calls
   */
  withToolCalls(toolCalls: AgentStructuredResponse["toolCalls"]): MockProvider {
    return new MockProvider({
      responseMessage: "I'll execute those tools for you.",
      structuredResponse: {
        message: "I'll execute those tools for you.",
        route: null,
        step: null,
        toolCalls,
      },
    });
  },
};
