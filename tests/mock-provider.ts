/**
 * The one mock provider for tests.
 *
 * Scripts structured replies per call kind: the framework names each call
 * through `parameters.schemaName` (`'understand'`, `'speak'`), and the mock
 * shifts the next scripted reply off that queue. An entry may be a function
 * of the input for replies that depend on the prompt. Running a queue dry
 * throws, so a test that spends more calls than it scripted fails loudly.
 * Every call is recorded in `.calls` for assertions on prompts and schemas.
 */

import type {
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
  GenerateMessageStreamChunk,
  ProviderCapabilities,
} from "../src/types/ai.js";

export type Structured = Record<string, unknown>;

export type Scripted = Structured | ((input: GenerateMessageInput) => Structured);

export interface MockCall {
  schemaName: string;
  prompt: string;
  input: GenerateMessageInput;
}

export interface MockProvider extends AiProvider {
  calls: MockCall[];
  /** Scripted replies not yet consumed, per schema name. */
  remaining(): Record<string, number>;
}

const CAPABILITIES: ProviderCapabilities = {
  supportsTools: true,
  supportsNativeJsonSchema: true,
  supportsStreaming: true,
  supportsStreamingToolCalls: true,
  supportsPromptCaching: false,
};

export function mockProvider(script: Record<string, Scripted[]> = {}): MockProvider {
  const queues = new Map<string, Scripted[]>(
    Object.entries(script).map(([name, replies]) => [name, [...replies]]),
  );
  const calls: MockCall[] = [];

  function next<TStructured>(input: GenerateMessageInput): GenerateMessageOutput<TStructured> {
    const schemaName = input.parameters?.schemaName ?? "(unnamed)";
    calls.push({ schemaName, prompt: input.prompt, input });
    const queue = queues.get(schemaName);
    const scripted = queue?.shift();
    if (scripted === undefined) {
      throw new Error(
        `mockProvider: no scripted "${schemaName}" reply left for call #${calls.length}. ` +
          `Script more replies or expect fewer calls.`,
      );
    }
    const structured = typeof scripted === "function" ? scripted(input) : scripted;
    const message = typeof structured.message === "string" ? structured.message : JSON.stringify(structured);
    return { message, structured: structured as TStructured, metadata: { model: "mock" } };
  }

  return {
    name: "mock",
    capabilities: CAPABILITIES,
    calls,
    remaining: () => Object.fromEntries([...queues].map(([name, queue]) => [name, queue.length])),
    generateMessage: <_C, TStructured>(input: GenerateMessageInput) =>
      Promise.resolve().then(() => next<TStructured>(input)),
    // eslint-disable-next-line @typescript-eslint/require-await -- one chunk, nothing to await
    async *generateMessageStream<_C, TStructured>(
      input: GenerateMessageInput,
    ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
      const out = next<TStructured>(input);
      yield { delta: out.message, accumulated: out.message, done: true, structured: out.structured, metadata: out.metadata };
    },
  };
}
