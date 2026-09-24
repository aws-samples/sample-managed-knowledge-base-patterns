/**
 * Aligns the streamed answer text with the citation offsets `AgenticRetrieveStream`
 * returns.
 *
 * The operation delivers its answer in two forms, each suited to its purpose:
 *
 * - incrementally, as `responseEvent.text` deltas, **with** inline `[1]`-style
 *   citation markers, which suits progressive display;
 * - once at the end, as `result.generatedResponse.answer`, with those markers
 *   **removed**.
 *
 * `citations[].startIndex` / `endIndex` are absolute character offsets into the
 * **final**, marker-free answer. Rendering the raw deltas and highlighting with those
 * spans would therefore shift each citation by the length of the markers before it.
 *
 * This module removes markers as the deltas arrive, so the concatenated deltas equal
 * the final answer and the domain's documented contract ("offsets index into the
 * concatenation of all `answer` events") holds.
 *
 * ## The removal rule
 *
 * Marker removal is **context-sensitive**:
 *
 * ```text
 * deltas:  ...quarter-over-quarter [1].\n\n## Breakdown
 * final:   ...quarter-over-quarter.\n\n## Breakdown        <- space removed
 *
 * deltas:  ...$3.1 million [1]\n- **Professional services**
 * final:   ...$3.1 million \n- **Professional services**   <- space kept
 * ```
 *
 * A marker followed by punctuation takes the space before it; a marker at end of
 * line does not. A simpler rule such as `/ ?\[\d+\]/` handles only the first case.
 *
 * The provider also checks the reconciliation at runtime and withholds citations if
 * the normalized stream and the final answer ever differ, and the integration test
 * asserts citations are not withheld.
 *
 * ## Why it needs state, and one character of lookahead
 *
 * Markers can span delta boundaries — for example `"emainder ["` then
 * `"1].\n\n### "`, or `"Q2 [1"` then `"].\n\n*"` — so a per-delta regex is not
 * enough. And because the rule depends on what *follows* a marker, a complete marker
 * is still undecidable until the next character arrives. This holds back the
 * shortest undecidable suffix and releases it as soon as the question is settled.
 */

/** Characters that pull the space before a marker along with it. */
const PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')']);

/**
 * Reference implementation of the transformation, applied to a whole answer.
 *
 * Defines correctness: {@link AnswerNormalizer} must agree with this for every
 * possible split of the same input, which is what its property test asserts.
 *
 * Deliberately marker-local. The tempting simplification — strip markers, then
 * globally collapse any space sitting before punctuation — would also rewrite text
 * that never contained a marker, so it would change an answer that legitimately
 * wrote `"see fig . 2"`.
 */
export function stripCitationMarkers(text: string): string {
  return text.replace(/ ?(?:\[\d+\])+(?=[.,;:!?)])/g, '').replace(/(?:\[\d+\])+/g, '');
}

/** ASCII digit test on a char code. */
function isDigit(charCode: number): boolean {
  return charCode >= 0x30 && charCode <= 0x39;
}

/** Outcome of scanning a buffer: text that is safe to emit, and what must be held. */
interface ScanResult {
  readonly out: string;
  readonly rest: string;
}

/**
 * Scans a buffer, removing complete marker runs.
 *
 * @param atEnd when true, no more input is coming, so an undecidable suffix is
 * resolved as "nothing follows" rather than held back.
 */
function scan(buffer: string, atEnd: boolean): ScanResult {
  let remaining = buffer;
  let out = '';

  for (;;) {
    const open = remaining.indexOf('[');

    if (open === -1) {
      // No marker can begin except at a '[', so everything is safe — except a
      // trailing space, which may turn out to precede a marker in the next delta.
      // Holding it back unconditionally is what lets the rest of this function
      // assume a preceding space is still visible in the buffer.
      if (!atEnd && remaining.endsWith(' ')) {
        out += remaining.slice(0, -1);
        remaining = ' ';
      } else {
        out += remaining;
        remaining = '';
      }
      break;
    }

    const hasSpace = open > 0 && remaining[open - 1] === ' ';
    const candidateStart = hasSpace ? open - 1 : open;

    // Consume a maximal run of complete adjacent markers: "[1]", "[1][2]", ...
    let cursor = open;
    let markers = 0;
    let incomplete = false;

    for (;;) {
      if (cursor >= remaining.length || remaining[cursor] !== '[') break;

      let digits = cursor + 1;
      while (digits < remaining.length && isDigit(remaining.charCodeAt(digits))) {
        digits += 1;
      }

      if (digits === remaining.length) {
        // Ran out mid-marker: '[', '[1', '[12'...
        incomplete = true;
        break;
      }
      if (digits === cursor + 1 || remaining[digits] !== ']') {
        // '[' not followed by digits-then-']' — literal text, not a marker.
        break;
      }

      markers += 1;
      cursor = digits + 1;
    }

    // An unterminated marker leaves everything undecidable: the run may still grow,
    // and whether the leading space survives depends on what eventually follows it.
    // This holds even when complete markers have already been consumed — deciding
    // early there would emit the space before discovering that the run continued.
    // The randomised split test covers this case.
    if (incomplete && !atEnd) {
      out += remaining.slice(0, candidateStart);
      remaining = remaining.slice(candidateStart);
      break;
    }

    if (markers === 0) {
      // Literal '['. Emit through it and keep scanning after it.
      out += remaining.slice(0, open + 1);
      remaining = remaining.slice(open + 1);
      continue;
    }

    // A complete run. Whether the preceding space goes with it depends on the
    // character after the run, which may not have arrived yet.
    if (cursor === remaining.length && !atEnd) {
      out += remaining.slice(0, candidateStart);
      remaining = remaining.slice(candidateStart);
      break;
    }

    const next = remaining[cursor];
    const spaceGoesWithMarker = next !== undefined && PUNCTUATION.has(next);

    out += remaining.slice(0, candidateStart);
    if (hasSpace && !spaceGoesWithMarker) out += ' ';
    remaining = remaining.slice(cursor);
  }

  return { out, rest: remaining };
}

/**
 * Incrementally removes citation markers from a stream of text deltas.
 *
 * Feed each delta to {@link push} and emit whatever it returns; call {@link flush}
 * once the stream ends. The concatenation of every returned string equals
 * `stripCitationMarkers(concat(deltas))`.
 */
export class AnswerNormalizer {
  /** Text held back because its treatment is not yet decidable. */
  private pending = '';

  /** Everything emitted, for the provider's end-of-stream reconciliation check. */
  private emitted = '';

  push(delta: string): string {
    const { out, rest } = scan(this.pending + delta, false);
    this.pending = rest;
    this.emitted += out;
    return out;
  }

  /**
   * Releases anything still held back, resolving it as end-of-input.
   *
   * A marker run at the very end of an answer has nothing after it, so no
   * punctuation follows and its preceding space is kept — the same answer the
   * reference implementation gives, whose lookahead simply fails at end of string.
   */
  flush(): string {
    const { out } = scan(this.pending, true);
    this.pending = '';
    this.emitted += out;
    return out;
  }

  /** Everything emitted so far, including anything released by {@link flush}. */
  get text(): string {
    return this.emitted;
  }
}
