/**
 * createOpenAICompatibleProvider — build a provider for any OpenAI-compatible
 * endpoint (Azure, Ollama, Groq, vLLM, a self-hosted gateway…) from config
 * alone, no subclass. These cover the factory's own logic: required-field
 * validation, public surface, and capability defaulting. The OpenAI SDK client
 * only stores config at construction, so no network is touched here.
 */
import { expect, test, describe } from "bun:test";

import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleOptions,
} from "../src/providers/GenericOpenAICompatibleProvider";
import { OpenAICompatibleProvider } from "../src/providers/OpenAICompatibleProvider";

const base: OpenAICompatibleOptions = {
  name: "ollama",
  baseURL: "http://localhost:11434/v1",
  apiKey: "ollama",
  model: "llama3.3",
};

describe("createOpenAICompatibleProvider", () => {
  test("builds a working provider from minimal config", () => {
    const provider = createOpenAICompatibleProvider(base);
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.name).toBe("ollama");
    // Sensible defaults for a modern compatible endpoint.
    expect(provider.capabilities.supportsStreaming).toBe(true);
    expect(provider.capabilities.supportsNativeJsonSchema).toBe(true);
    expect(provider.capabilities.supportsTools).toBe(true);
  });

  test("capability overrides merge over the defaults", () => {
    const provider = createOpenAICompatibleProvider({
      ...base,
      capabilities: { supportsTools: false, supportsPromptCaching: true },
    });
    expect(provider.capabilities.supportsTools).toBe(false); // overridden
    expect(provider.capabilities.supportsPromptCaching).toBe(true); // overridden
    expect(provider.capabilities.supportsStreaming).toBe(true); // untouched default
  });

  test.each([
    ["name", { ...base, name: "" }],
    ["baseURL", { ...base, baseURL: "" }],
    ["apiKey", { ...base, apiKey: "" }],
    ["model", { ...base, model: "" }],
  ])("throws when %s is missing", (_field, options) => {
    expect(() => createOpenAICompatibleProvider(options)).toThrow();
  });

  test("accepts custom headers (e.g. Azure api-key) without throwing", () => {
    const provider = createOpenAICompatibleProvider({
      name: "azure",
      baseURL: "https://res.openai.azure.com/openai/deployments/gpt-4o",
      apiKey: "k",
      model: "gpt-4o",
      defaultHeaders: { "api-key": "k" },
      structuredOutput: "json_object",
    });
    expect(provider.name).toBe("azure");
  });
});
