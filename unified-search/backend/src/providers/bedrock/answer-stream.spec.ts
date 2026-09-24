import { describe, expect, it } from 'vitest';

import { AnswerNormalizer, stripCitationMarkers } from './answer-stream.js';

/**
 * The normalizer exists because `AgenticRetrieveStream` streams answer text with
 * inline `[n]` citation markers and then reports a final answer with them removed,
 * while citation offsets index into the *removed* form. A mistake here would shift
 * every citation highlight, so it is tested harder than its size suggests.
 */

/** Feeds deltas through a normalizer and returns the full normalized text. */
function normalize(deltas: readonly string[]): string {
  const normalizer = new AnswerNormalizer();
  const out =
    deltas.map((delta) => normalizer.push(delta)).join('') + normalizer.flush();

  // The accumulator must agree with what was actually returned, since the provider
  // relies on `text` for its reconciliation check.
  expect(normalizer.text).toBe(out);
  return out;
}

describe('stripCitationMarkers', () => {
  it('removes a marker and the single space before it', () => {
    expect(stripCitationMarkers('Revenue is $4.2 million [1].')).toBe(
      'Revenue is $4.2 million.',
    );
  });

  it('removes runs of adjacent markers', () => {
    expect(stripCitationMarkers('Both sources agree [1][2].')).toBe(
      'Both sources agree.',
    );
  });

  it('leaves bracketed text that is not a marker alone', () => {
    expect(stripCitationMarkers('See [appendix] and [1a] and [].')).toBe(
      'See [appendix] and [1a] and [].',
    );
  });

  it('removes multi-digit markers', () => {
    expect(stripCitationMarkers('As noted [12].')).toBe('As noted.');
  });
});

describe('AnswerNormalizer', () => {
  it('reproduces the whole-string transformation when fed one delta', () => {
    const answer = 'Revenue is $4.2 million [1], up 11% [2].';
    expect(normalize([answer])).toBe(stripCitationMarkers(answer));
  });

  /**
   * The case a per-delta regex gets wrong. Markers can split across event
   * boundaries, and these pairs cover the shapes that produces.
   */
  describe('markers that straddle delta boundaries', () => {
    const observed: readonly (readonly string[])[] = [
      ['emainder [', '1].\n\n### '],
      ['Q2 [1', '].\n\n*'],
      ['red to Q2 [', '1].'],
      ['uarter** [1', '].\n'],
      ['ing [', '1].\n'],
      // Split at every possible point inside " [1]".
      ['text ', '[1] more'],
      ['text [', '1] more'],
      ['text [1', '] more'],
      ['text [1]', ' more'],
      // A space that ends one delta and is followed by a non-marker.
      ['text ', 'more'],
      // Three-way split.
      ['text ', '[', '1', ']', ' more'],
      // The decisive character arrives in a later delta than the marker, which is
      // what forces a lookahead state rather than deciding at ']'.
      ['million [1]', '.'],
      ['million [1]', '\n'],
      ['million [1]', ' more'],
      ['million [1]', ''],
    ];

    for (const deltas of observed) {
      it(`handles ${JSON.stringify(deltas)}`, () => {
        expect(normalize(deltas)).toBe(stripCitationMarkers(deltas.join('')));
      });
    }
  });

  it('emits a held-back trailing space when the stream ends', () => {
    // The space is held back in case a '[' follows. When nothing follows, it is
    // literal text and must still be emitted.
    expect(normalize(['done '])).toBe('done ');
  });

  it('emits an unterminated marker verbatim', () => {
    expect(normalize(['truncated [1'])).toBe('truncated [1');
    expect(normalize(['truncated ['])).toBe('truncated [');
  });

  it('resolves a trailing marker run as end-of-input', () => {
    // Nothing follows, so no punctuation follows, so the space is kept — matching
    // the reference implementation, whose lookahead fails at end of string.
    expect(normalize(['ends with a citation [1]'])).toBe('ends with a citation ');
    expect(normalize(['ends with a citation [1]', ''])).toBe('ends with a citation ');
  });

  /**
   * Exhaustive over every two-way split of several shapes, and over every three-way
   * split of the hardest one: a marker run followed by an unterminated marker,
   * where deciding the leading space too early would emit it incorrectly. The
   * randomised test below complements these with arbitrary multi-way splits.
   */
  it('agrees with the reference for every two-way split', () => {
    const answers = [
      'A [1] B [2] C [10] D [3].',
      // Runs, adjacent to both punctuation and newlines.
      'Both agree [1][2]. Next [3][4]\nEnd [5][6]',
      'million [1]\n- next',
      'quarter [1]. next',
      'trailing [1]',
    ];

    for (const answer of answers) {
      for (let at = 0; at <= answer.length; at += 1) {
        expect(
          normalize([answer.slice(0, at), answer.slice(at)]),
          `${JSON.stringify(answer)} split at ${String(at)}`,
        ).toBe(stripCitationMarkers(answer));
      }
    }
  });

  it('agrees with the reference for every three-way split of a marker run', () => {
    // The hardest case: whether the leading space survives depends on text that
    // can arrive two deltas after the first marker closes.
    const answer = 'agree [1][2]. done';
    for (let i = 0; i <= answer.length; i += 1) {
      for (let j = i; j <= answer.length; j += 1) {
        expect(
          normalize([answer.slice(0, i), answer.slice(i, j), answer.slice(j)]),
          `split at ${String(i)},${String(j)}`,
        ).toBe(stripCitationMarkers(answer));
      }
    }
  });

  /**
   * The property that actually matters: however the service chooses to chunk the
   * text, the normalized result is the same as transforming the whole answer at
   * once. Exhaustive single-split coverage above, randomised multi-split here.
   */
  it('agrees with the whole-string transformation for arbitrary random splits', () => {
    // Deterministic PRNG: a flaky guard is not a guard.
    let seed = 0x2f6e2b1;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    // Covers every marker context: marker before punctuation,
    // before a newline, before a word, in a run, at end of input, plus bracketed
    // text that is not a marker at all.
    const answer =
      'The projected Q3 revenue forecast is **$4.2 million** [1], representing an 11% ' +
      'increase quarter-over-quarter [2].\n\n## Breakdown\n- Subscription revenue: ' +
      '$3.1 million [1]\n- Professional services: ~$1.1 million [10]\n\n' +
      'Renewal rate holds steady at 92% [1]\n- Two deals close [2]\n\n' +
      'See [appendix] for the [unbracketed] detail, and note [] and [3a] are not markers. ' +
      'A marker [1] followed by a word, and one before a paren [2]) too. ' +
      'Both agree [1][2]. Trailing citation [12]';

    for (let trial = 0; trial < 300; trial += 1) {
      const deltas: string[] = [];
      let cursor = 0;
      while (cursor < answer.length) {
        // Small chunks, since that is where boundary bugs live.
        const size = 1 + Math.floor(random() * 6);
        deltas.push(answer.slice(cursor, cursor + size));
        cursor += size;
      }

      expect(normalize(deltas), `trial ${String(trial)}`).toBe(
        stripCitationMarkers(answer),
      );
    }
  });

  it('handles an empty stream and empty deltas', () => {
    expect(normalize([])).toBe('');
    expect(normalize(['', '', ''])).toBe('');
  });
});
