import { describe, expect, it } from 'vitest';

import { markdownToPlainText, snippetText } from './plain-text.ts';

describe('markdownToPlainText', () => {
  /** The exact shape a result snippet arrived in, which rendered as visible syntax. */
  it('flattens a real document chunk', () => {
    const chunk = [
      '# Q3 Revenue Forecast',
      '',
      'AnyCompany — Finance team.',
      '',
      '## Summary',
      '',
      'Projected Q3 revenue is **4.2 million dollars**, up 11 percent.',
      '',
      '## Assumptions',
      '- Renewal rate holds at 92 percent.',
      '- No change to list pricing.',
    ].join('\n');

    expect(markdownToPlainText(chunk)).toBe(
      'Q3 Revenue Forecast AnyCompany — Finance team. Summary Projected Q3 revenue ' +
        'is 4.2 million dollars, up 11 percent. Assumptions Renewal rate holds at 92 ' +
        'percent. No change to list pricing.',
    );
  });

  it('strips heading markers only at the start of a line', () => {
    // A `#` mid-sentence is a real character, e.g. "ticket #42".
    expect(markdownToPlainText('## Heading\nSee ticket #42.')).toBe(
      'Heading See ticket #42.',
    );
  });

  it('keeps link text and drops the target', () => {
    expect(markdownToPlainText('See [the runbook](https://example.test/r).')).toBe(
      'See the runbook.',
    );
  });

  it('keeps image alt text', () => {
    expect(markdownToPlainText('![architecture diagram](a.png)')).toBe(
      'architecture diagram',
    );
  });

  it('removes bold and italic without leaving stray markers', () => {
    expect(markdownToPlainText('**bold** and *italic* and __also__ and _this_')).toBe(
      'bold and italic and also and this',
    );
  });

  it('flattens lists, quotes and rules', () => {
    expect(markdownToPlainText('> quoted\n\n- one\n- two\n\n---\n\n1. first')).toBe(
      'quoted one two first',
    );
  });

  it('keeps code content but drops the fences and backticks', () => {
    expect(markdownToPlainText('```ts\nconst a = 1;\n```\nand `inline` too')).toBe(
      'const a = 1; and inline too',
    );
  });

  it('collapses table pipes into spaces', () => {
    expect(markdownToPlainText('| a | b |\n| - | - |\n| 1 | 2 |')).toBe('a b - - 1 2');
  });

  /**
   * Snippets are the least trusted text in the application. Flattening must produce a
   * plain string and never anything a renderer would interpret.
   */
  it('leaves embedded HTML as inert text', () => {
    const hostile = '<img src=x onerror="alert(1)"> and <script>alert(2)</script>';

    // Unchanged, and therefore rendered as text by React rather than parsed as markup.
    expect(markdownToPlainText(hostile)).toContain('onerror');
    expect(markdownToPlainText(hostile)).toContain('script');
  });

  it('handles an empty or whitespace-only chunk', () => {
    expect(markdownToPlainText('')).toBe('');
    expect(markdownToPlainText('   \n\n  ')).toBe('');
  });
});

describe('snippetText', () => {
  it('leaves a short snippet alone', () => {
    expect(snippetText('Short enough.')).toBe('Short enough.');
  });

  it('truncates at a word boundary with an ellipsis', () => {
    // Words of uneven length, so the cut point lands inside a word rather than on a space
    // by coincidence. A repeated fixed-length word with a limit that divides it exactly
    // would pass without checking anything.
    const long =
      'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike';

    for (const limit of [20, 27, 33, 41, 55]) {
      const result = snippetText(long, limit);
      expect(result.endsWith('…'), `limit ${String(limit)}`).toBe(true);

      const body = result.slice(0, -1);
      // The character following the cut in the source must be a space, which is what
      // "cut at a word boundary" means. Ending mid-word reads as corrupted text.
      expect(
        long[body.length],
        `limit ${String(limit)} cut inside "${body.slice(-12)}"`,
      ).toBe(' ');
    }
  });

  it('falls back to a hard cut when there is no usable word boundary', () => {
    const result = snippetText('a'.repeat(100), 20);

    expect(result).toHaveLength(21);
    expect(result.endsWith('…')).toBe(true);
  });

  it('flattens before measuring, so markers do not consume the budget', () => {
    // Without flattening first, the syntax would count towards the limit and the visible
    // text would be shorter than intended.
    expect(snippetText('## **Heading**', 40)).toBe('Heading');
  });
});
