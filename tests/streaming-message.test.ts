/**
 * Incremental message extraction from streamed structured JSON.
 *
 * Real providers stream the raw JSON wrapper (`{"message":"Hel` → `…lo"}`),
 * not the message text. extractMessageSoFar / StreamingMessageDecoder recover
 * the clean user-facing tokens at any truncation point.
 */
import { expect, test, describe } from "bun:test";

import { extractMessageSoFar, StreamingMessageDecoder } from "../src/utils/streamingMessage";

/** Feed a string one character at a time; assert the message-so-far is always a clean prefix. */
function streamCharByChar(full: string): { messages: string[]; finalDelta: string } {
  const decoder = new StreamingMessageDecoder();
  const messages: string[] = [];
  let finalDelta = "";
  let acc = "";
  for (const ch of full) {
    acc += ch;
    const { message, delta } = decoder.push(acc);
    messages.push(message);
    finalDelta = delta;
  }
  return { messages, finalDelta };
}

describe("extractMessageSoFar", () => {
  test("extracts a complete top-level message", () => {
    expect(extractMessageSoFar('{"message":"Hello world"}')).toBe("Hello world");
  });

  test("returns the partial message while the value is still streaming", () => {
    expect(extractMessageSoFar('{"message":"Hello wor')).toBe("Hello wor");
  });

  test("returns empty before the message value begins", () => {
    expect(extractMessageSoFar("{")).toBe("");
    expect(extractMessageSoFar('{"mess')).toBe("");
    expect(extractMessageSoFar('{"message"')).toBe("");
    expect(extractMessageSoFar('{"message":')).toBe("");
    expect(extractMessageSoFar('{"message":"')).toBe("");
  });

  test("passes through plain (non-JSON) text verbatim", () => {
    expect(extractMessageSoFar("Hello! How can I help?")).toBe("Hello! How can I help?");
    expect(extractMessageSoFar("Hello")).toBe("Hello");
  });

  test("decodes escape sequences", () => {
    expect(extractMessageSoFar('{"message":"line1\\nline2"}')).toBe("line1\nline2");
    expect(extractMessageSoFar('{"message":"a \\"quote\\" b"}')).toBe('a "quote" b');
    expect(extractMessageSoFar('{"message":"back\\\\slash"}')).toBe("back\\slash");
    expect(extractMessageSoFar('{"message":"tab\\there"}')).toBe("tab\there");
  });

  test("decodes \\uXXXX escapes", () => {
    expect(extractMessageSoFar('{"message":"snow\\u2603man"}')).toBe("snow☃man");
  });

  test("holds back a dangling escape until complete", () => {
    // A lone backslash at the truncation point must not emit a half-decoded char.
    expect(extractMessageSoFar('{"message":"done\\')).toBe("done");
    expect(extractMessageSoFar('{"message":"done\\n')).toBe("done\n");
    // Partial \uXXXX is held back too.
    expect(extractMessageSoFar('{"message":"x\\u26')).toBe("x");
    expect(extractMessageSoFar('{"message":"x\\u2603')).toBe("x☃");
  });

  test("finds the top-level message even when it is not the first field", () => {
    expect(extractMessageSoFar('{"step":"ask","message":"Hi there"}')).toBe("Hi there");
    expect(extractMessageSoFar('{"score":42,"flag":true,"message":"Hi"}')).toBe("Hi");
  });

  test("ignores a decoy message inside an earlier field's value", () => {
    // The substring "message" appears inside the `name` value — must not match it.
    expect(extractMessageSoFar('{"name":"the message field","message":"real"}')).toBe("real");
  });

  test("ignores a nested decoy message key", () => {
    // A nested object with its own "message" must not be mistaken for the top-level one.
    expect(
      extractMessageSoFar('{"meta":{"message":"nested"},"message":"top"}')
    ).toBe("top");
  });

  test("does not mistake } inside the string for the object end", () => {
    expect(extractMessageSoFar('{"message":"a } b { c"}')).toBe("a } b { c");
  });

  test("returns empty for a null message value", () => {
    expect(extractMessageSoFar('{"message":null}')).toBe("");
  });

  test("tolerates leading whitespace", () => {
    expect(extractMessageSoFar('  \n {"message":"Hi"}')).toBe("Hi");
  });
});

describe("StreamingMessageDecoder", () => {
  test("yields monotonic clean prefixes char-by-char, deltas concatenate to the message", () => {
    const decoder = new StreamingMessageDecoder();
    const full = '{"message":"Hello, world!"}';
    let acc = "";
    let reassembled = "";
    let last = "";
    for (const ch of full) {
      acc += ch;
      const { message, delta } = decoder.push(acc);
      // message-so-far only ever grows and stays a prefix of the previous.
      expect(message.startsWith(last)).toBe(true);
      last = message;
      reassembled += delta;
    }
    expect(last).toBe("Hello, world!");
    expect(reassembled).toBe("Hello, world!");
  });

  test("char-by-char never emits a half-decoded escape", () => {
    const { messages } = streamCharByChar('{"message":"a\\nb\\u2603c"}');
    // Every intermediate message must be a valid prefix of the final decoded text.
    const finalText = "a\nb☃c";
    for (const m of messages) {
      expect(finalText.startsWith(m)).toBe(true);
    }
    expect(messages[messages.length - 1]).toBe(finalText);
  });

  test("plain-text stream deltas pass through and concatenate", () => {
    const decoder = new StreamingMessageDecoder();
    expect(decoder.push("Hello").delta).toBe("Hello");
    expect(decoder.push("Hello world").delta).toBe(" world");
    expect(decoder.push("Hello world!").message).toBe("Hello world!");
  });
});
