/**
 * Splitting an AI-judged phrase list into what counts and what rules it out.
 *
 * A trigger's phrases are alternatives: one match is enough. That makes the
 * list useless for saying "but not this" — and "but not this" is what keeps a
 * classifier honest. A customer answering "pode sim" to an offer of a meeting
 * is agreeing to the meeting, not asking for a human, and without a way to say
 * so every cheerful yes reads as a handoff request.
 *
 * So a phrase that opens with `!` is an exclusion: it does not make the trigger
 * fire, it stops it. Exclusions win over matches, and the model is told both
 * lists separately.
 */

export interface Phrases {
  /** Any one of these makes it true. */
  counts: string[];
  /** Any one of these makes it false, whatever matched. */
  excludes: string[];
}

/**
 * Split a phrase list on the leading `!`. Blank entries and a bare `"!"` are
 * dropped: they would render as an empty bullet and mean nothing to the model.
 */
export function splitPhrases(phrases: readonly string[]): Phrases {
  const counts: string[] = [];
  const excludes: string[] = [];
  for (const phrase of phrases) {
    const trimmed = phrase.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("!")) {
      const body = trimmed.slice(1).trim();
      if (body) excludes.push(body);
      continue;
    }
    counts.push(trimmed);
  }
  return { counts, excludes };
}
