import type { Citation } from '@domain';
import { describe, expect, it } from 'vitest';

import { withInlineCitations } from './inline-citations.ts';

function citation(
  start: number,
  end: number,
  refs: readonly { id?: string; ds?: string; title?: string }[],
): Citation {
  return {
    span: { start, end },
    text: '',
    references: refs.map((ref) => ({
      snippet: 'passage',
      sourceType: 's3' as const,
      ...(ref.id === undefined ? {} : { documentId: ref.id }),
      ...(ref.ds === undefined ? {} : { dataSourceId: ref.ds }),
      ...(ref.title === undefined ? {} : { title: ref.title }),
    })),
  };
}

/** Header text the citation column uses. */
const SOURCES_HEADER = 'Sources';

const DOC_A = { id: 's3://b/content/finance/q3.md', ds: 'DS1', title: 'q3.md' };
const DOC_B = { id: 's3://b/content/finance/arr.md', ds: 'DS1', title: 'arr.md' };

describe('withInlineCitations', () => {
  it('marks the end of each cited span', () => {
    const text = 'Revenue is up. Costs are flat.';
    const { text: marked } = withInlineCitations(text, [
      citation(0, 14, [DOC_A]),
      citation(15, 30, [DOC_B]),
    ]);

    expect(marked).toBe(
      'Revenue is up. [[1]](</document?id=s3%3A%2F%2Fb%2Fcontent%2Ffinance%2Fq3.md&source=DS1&title=q3.md>)' +
        ' Costs are flat. [[2]](</document?id=s3%3A%2F%2Fb%2Fcontent%2Ffinance%2Farr.md&source=DS1&title=arr.md>)',
    );
  });

  /**
   * Each inserted marker changes the text length, so later offsets must still point at the
   * right place, or the second marker lands a marker-length too early. Short answers with
   * one citation would not reveal this.
   */
  it('keeps later offsets valid when several markers are inserted', () => {
    const text = 'AAAA BBBB CCCC';
    const { text: marked } = withInlineCitations(text, [
      citation(0, 4, [DOC_A]),
      citation(5, 9, [DOC_B]),
    ]);

    expect(marked.indexOf('[[1]]')).toBeLessThan(marked.indexOf('BBBB'));
    expect(marked.indexOf('[[2]]')).toBeGreaterThan(marked.indexOf('BBBB'));
    expect(marked.indexOf('[[2]]')).toBeLessThan(marked.indexOf('CCCC'));
  });

  it('numbers a document once however often it is cited', () => {
    const { text: marked, sources } = withInlineCitations('One. Two. Three.', [
      citation(0, 4, [DOC_A]),
      citation(5, 9, [DOC_A]),
      citation(10, 16, [DOC_B]),
    ]);

    expect(sources).toHaveLength(2);
    expect(sources.map((source) => source.number)).toEqual([1, 2]);
    // Two claims, one document, so [1] appears twice and there is no [3].
    expect(marked.match(/\[\[1\]\]/g)).toHaveLength(2);
    expect(marked).not.toContain('[[3]]');
  });

  it('numbers sources in the order the reader meets them', () => {
    const { sources } = withInlineCitations('One. Two.', [
      citation(0, 4, [DOC_B]),
      citation(5, 9, [DOC_A]),
    ]);

    expect(sources[0]?.title).toBe('arr.md');
    expect(sources[1]?.title).toBe('q3.md');
  });

  it('renders several sources for one claim as adjacent markers', () => {
    const { text: marked } = withInlineCitations('Both agree.', [
      citation(0, 11, [DOC_A, DOC_B]),
    ]);

    expect(marked).toContain('[[1]]');
    expect(marked).toContain('[[2]]');
    expect(marked.indexOf('[[1]]')).toBeLessThan(marked.indexOf('[[2]]'));
  });

  describe('tables', () => {
    const TABLE = [
      'Figures:',
      '',
      '| Period | ARR |',
      '| --- | --- |',
      '| Q2 2025 | 4.0 |',
      '| Q1 2026 | 9.2 |',
      '',
      'Done.',
    ].join('\n');

    /**
     * A marker cannot go inside a row without adding a cell and corrupting it, and a caption
     * underneath costs a block of vertical space per citation. A column costs one column
     * once, and puts each citation on the row it actually supports.
     */
    it('adds a Sources column and marks only the row the citation covers', () => {
      const rowStart = TABLE.indexOf('| Q1 2026');
      const { text: marked } = withInlineCitations(TABLE, [
        citation(rowStart, rowStart + 17, [DOC_A]),
      ]);
      const lines = marked.split('\n');

      expect(lines[2]).toBe('| Period | ARR | Sources |');
      // The delimiter row has to gain a column too, or the table stops parsing as a table.
      expect(lines[3]).toBe('| --- | --- | --- |');
      expect(lines[4]).toBe('| Q2 2025 | 4.0 |  |');
      expect(lines[5]).toContain('[[1]]');
      expect(lines[5]?.startsWith('| Q1 2026 | 9.2 |')).toBe(true);
    });

    /**
     * A citation may span the whole table, running from the header to the end of the last
     * row. Every row it covers carries the marker, which is what a Sources column is for.
     */
    it('marks every row a table-wide citation covers', () => {
      const { text: marked } = withInlineCitations(TABLE, [
        citation(TABLE.indexOf('| Period'), TABLE.indexOf('| Q1 2026') + 17, [DOC_A]),
      ]);
      const body = marked.split('\n').slice(4, 6);

      expect(body).toHaveLength(2);
      for (const row of body) expect(row).toContain('[[1]]');
    });

    /**
     * A citation that only passes through a table on its way to prose belongs in the prose,
     * because that is where it ends and where the claim it supports is written.
     */
    it('stays inline when the span ends in prose after the table', () => {
      const { text: marked } = withInlineCitations(TABLE, [
        citation(0, TABLE.indexOf('Done.') + 5, [DOC_A]),
      ]);
      const lines = marked.split('\n');

      expect(lines[2]).toBe('| Period | ARR |');
      expect(lines.at(-1)).toContain('Done.');
      expect(lines.at(-1)).toContain('[[1]]');
    });

    it('leaves an uncited table alone', () => {
      const { text: marked } = withInlineCitations(TABLE, []);

      expect(marked).toBe(TABLE);
      expect(marked).not.toContain(SOURCES_HEADER);
    });

    it('adds the column once when several citations land on one table', () => {
      const rowA = TABLE.indexOf('| Q2 2025');
      const rowB = TABLE.indexOf('| Q1 2026');
      const { text: marked } = withInlineCitations(TABLE, [
        citation(rowA, rowA + 17, [DOC_A]),
        citation(rowB, rowB + 17, [DOC_B]),
      ]);
      const lines = marked.split('\n');

      expect(lines[2]?.match(new RegExp(SOURCES_HEADER, 'g'))).toHaveLength(1);
      expect(lines[4]).toContain('[[1]]');
      expect(lines[5]).toContain('[[2]]');
    });

    it('falls back to a paragraph when the table has no body rows', () => {
      const headerOnly = 'Figures:\n\n| Period | ARR |\n| --- | --- |';
      const { text: marked } = withInlineCitations(headerOnly, [
        citation(0, headerOnly.length, [DOC_A]),
      ]);

      expect(marked).not.toContain(SOURCES_HEADER);
      expect(marked).toContain('| --- | --- |\n\n[[1]]');
    });
  });

  describe('code fences', () => {
    it('displaces the marker to a paragraph after the block', () => {
      const text = 'Example:\n\n```json\n{ "arr": 4.0 }\n```\n\nDone.';
      const inside = text.indexOf('"arr"');

      const { text: marked } = withInlineCitations(text, [
        citation(0, inside, [DOC_A]),
      ]);

      // Code has no cell to put a marker in and no safe position inside it.
      expect(marked).toContain('{ "arr": 4.0 }');
      expect(marked.split('```')[1]).not.toContain('[[1]]');
      expect(marked).toContain('```\n\n[[1]]');
    });
  });
  describe('references that cannot be opened', () => {
    it('still numbers a reference with no data source, as plain text', () => {
      const { text: marked, sources } = withInlineCitations('Claim.', [
        citation(0, 6, [{ id: 's3://b/x.md', title: 'x.md' }]),
      ]);

      // Numbered so the answer and the source list agree, but not a link, because the
      // viewer needs both identifiers and a link that cannot work is worse than none.
      expect(marked).toContain('[1]');
      expect(marked).not.toContain('](');
      expect(sources[0]?.href).toBeUndefined();
    });

    it('ignores a reference with nothing to identify it', () => {
      const { text: marked, sources } = withInlineCitations('Claim.', [
        citation(0, 6, [{}]),
      ]);

      expect(sources).toHaveLength(0);
      expect(marked).toBe('Claim.');
    });
  });

  it('returns the answer unchanged when there are no citations', () => {
    const { text: marked, sources } = withInlineCitations('# Heading\n\nBody.', []);

    expect(marked).toBe('# Heading\n\nBody.');
    expect(sources).toEqual([]);
  });

  it('does not double the space when a span ends on whitespace', () => {
    const { text: marked } = withInlineCitations('Revenue is up. Costs flat.', [
      citation(0, 15, [DOC_A]),
    ]);

    expect(marked).not.toMatch(/ {2}\[\[1\]\]/);
  });
});
