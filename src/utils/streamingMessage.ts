/**
 * Incremental extraction of the `message` field from a streamed structured
 * JSON response.
 *
 * Providers that enforce a JSON schema stream the raw wrapper object
 * (`{"message":"Hel` → `{"message":"Hello"}`), not the message text. Without
 * this, every streaming consumer has to re-implement partial-JSON unwrapping to
 * recover the user-facing tokens. These helpers do it once, at the framework
 * boundary, so `delta`/`accumulated` carry clean message text and the parsed
 * object is surfaced only when complete.
 *
 * The extractor targets the top-level `message` string field specifically
 * (tracking object depth and string context, so a nested decoy `"message"` key
 * or a `"message"` substring inside another value is never mistaken for it),
 * and is tolerant of truncation at any byte — a dangling escape sequence is
 * held back rather than emitted half-decoded. Input that is not a JSON object
 * (e.g. a provider streaming plain text) is passed through verbatim.
 */

const WHITESPACE = " \t\n\r";

const ESCAPE_CHARS: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

interface StringRead {
  /** Decoded value, or decoded prefix when the closing quote has not arrived. */
  value: string;
  /** Index just past the closing quote when complete; the input length otherwise. */
  end: number;
  /** Whether the closing quote was seen. */
  complete: boolean;
}

/**
 * Read a JSON string token whose opening quote is at `s[start]`. Decodes
 * escapes. When the closing quote has not arrived, returns the decoded prefix
 * with any trailing incomplete escape (`\` or a partial `\uXXXX`) held back, so
 * a half-decoded character is never produced.
 */
function readJsonString(s: string, start: number): StringRead {
  let out = "";
  const n = s.length;
  let i = start + 1; // skip opening quote

  while (i < n) {
    const ch = s[i];

    if (ch === '"') {
      return { value: out, end: i + 1, complete: true };
    }

    if (ch === "\\") {
      const esc = s[i + 1];
      if (esc === undefined) {
        // Dangling backslash — wait for the rest of the escape.
        return { value: out, end: n, complete: false };
      }
      if (esc === "u") {
        if (i + 6 > n) {
          // Incomplete \uXXXX — hold it back.
          return { value: out, end: n, complete: false };
        }
        const code = parseInt(s.slice(i + 2, i + 6), 16);
        if (Number.isNaN(code)) {
          return { value: out, end: n, complete: false };
        }
        out += String.fromCharCode(code);
        i += 6;
      } else if (esc in ESCAPE_CHARS) {
        out += ESCAPE_CHARS[esc];
        i += 2;
      } else {
        // Not a valid JSON escape; pass the character through leniently.
        out += esc;
        i += 2;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return { value: out, end: n, complete: false };
}

interface ValueSkip {
  end: number;
  complete: boolean;
}

/**
 * Skip one JSON value (string, object, array, or primitive) starting at `s[i]`.
 * Tolerant of truncation: an unfinished value reports `complete: false`.
 */
function skipJsonValue(s: string, i: number): ValueSkip {
  const n = s.length;
  if (i >= n) return { end: n, complete: false };

  const ch = s[i];

  if (ch === '"') {
    const r = readJsonString(s, i);
    return { end: r.end, complete: r.complete };
  }

  if (ch === "{" || ch === "[") {
    let depth = 0;
    let j = i;
    while (j < n) {
      const c = s[j];
      if (c === '"') {
        const r = readJsonString(s, j);
        if (!r.complete) return { end: n, complete: false };
        j = r.end;
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return { end: j + 1, complete: true };
      }
      j++;
    }
    return { end: n, complete: false };
  }

  // Primitive (number, true, false, null): runs until a structural delimiter.
  // Hitting end-of-input first means it may still be streaming.
  let j = i;
  while (j < n && !`,}]${WHITESPACE}`.includes(s[j])) j++;
  return j < n ? { end: j, complete: true } : { end: n, complete: false };
}

/**
 * Extract the decoded value of the top-level `message` string field from a
 * (possibly partial) JSON object string, returning the text available so far.
 *
 * Returns `""` while the `message` value has not begun streaming, and passes
 * `accumulated` through unchanged when it is not a JSON object.
 */
export function extractMessageSoFar(accumulated: string): string {
  const s = accumulated;
  const n = s.length;

  let i = 0;
  while (i < n && WHITESPACE.includes(s[i])) i++;

  // Not a JSON object — a plain-text stream; emit verbatim.
  if (i >= n || s[i] !== "{") return accumulated;
  i++; // skip '{'

  while (i < n) {
    while (i < n && (WHITESPACE.includes(s[i]) || s[i] === ",")) i++;
    if (i >= n) return "";
    if (s[i] === "}") return ""; // object closed without a message
    if (s[i] !== '"') return ""; // key not (fully) arrived

    const key = readJsonString(s, i);
    if (!key.complete) return ""; // key still streaming
    i = key.end;

    while (i < n && WHITESPACE.includes(s[i])) i++;
    if (i >= n || s[i] !== ":") return ""; // colon not arrived
    i++;
    while (i < n && WHITESPACE.includes(s[i])) i++;
    if (i >= n) return "";

    if (key.value === "message") {
      // Found it. Only a string value yields text; null/other → no message yet.
      if (s[i] !== '"') return "";
      return readJsonString(s, i).value;
    }

    // A field before `message`: skip its value. If it is still streaming we
    // cannot have reached `message` yet.
    const skipped = skipJsonValue(s, i);
    if (!skipped.complete) return "";
    i = skipped.end;
  }

  return "";
}

/**
 * Stateful wrapper over {@link extractMessageSoFar} for a single stream: feed
 * each chunk's accumulated JSON and get back the clean message-so-far plus the
 * newly revealed delta.
 *
 * Each push re-scans the full accumulated buffer (O(n) per chunk, O(n²) over a
 * stream) — deliberately kept simple and stateless: at LLM response sizes (KBs)
 * the cost is negligible, and it avoids carrying cross-chunk parser/escape state.
 */
export class StreamingMessageDecoder {
  private previous = "";

  /**
   * @param accumulated The provider chunk's full accumulated output so far.
   * @returns `message` (clean text so far) and `delta` (the new text since the
   *          previous push).
   */
  push(accumulated: string): { message: string; delta: string } {
    const message = extractMessageSoFar(accumulated);
    // Decoding is monotonic (each push extends the prefix); the guard is a
    // belt-and-braces reset for any non-prefix anomaly.
    const delta = message.startsWith(this.previous)
      ? message.slice(this.previous.length)
      : message;
    this.previous = message;
    return { message, delta };
  }
}
