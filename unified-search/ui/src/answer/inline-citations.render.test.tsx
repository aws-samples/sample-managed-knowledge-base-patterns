import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { Citation } from '@domain';

import { Markdown } from '../markdown/Markdown.tsx';
import { withInlineCitations } from './inline-citations.ts';

/**
 * The two halves of inline citation, checked together against a rendered DOM.
 *
 * `inline-citations.test.ts` asserts where markers land in the Markdown string, and that
 * is not sufficient on its own. Markers on the line directly below a table's last row
 * contain no pipes, so a string-level test looking for markers on `|` lines would see
 * nothing amiss, yet GFM reads that line as one more row and the citations render as a
 * stray table row with empty cells.
 *
 * Whether a marker corrupts a table is a question about the parsed document, so it has to be
 * asked of the parsed document.
 */

const DOC = {
  snippet: 'passage',
  sourceType: 's3' as const,
  documentId: 's3://bucket/content/finance/q3.md',
  dataSourceId: 'DS1',
  title: 'q3.md',
};

function citation(start: number, end: number): Citation {
  return { span: { start, end }, text: '', references: [DOC] };
}

function renderCited(text: string, citations: readonly Citation[]) {
  const cited = withInlineCitations(text, citations);
  return {
    ...render(
      <MemoryRouter>
        <Markdown>{cited.text}</Markdown>
      </MemoryRouter>,
    ),
    cited,
  };
}

const TABLE = [
  'Figures by quarter:',
  '',
  '| Period | ARR |',
  '| --- | --- |',
  '| Q2 2025 | 4.0 |',
  '| Q1 2026 | 9.2 |',
  '',
  'Notes follow.',
].join('\n');

/** A citation spanning the whole table. */
const WHOLE_TABLE = citation(
  TABLE.indexOf('| Period'),
  TABLE.indexOf('| Q1 2026') + 17,
);

describe('citations rendered into Markdown', () => {
  describe('a cited table', () => {
    it('gains a column rather than a row', () => {
      renderCited(TABLE, [WHOLE_TABLE]);

      // Header plus two data rows. A third row means markers were absorbed as one.
      expect(screen.getAllByRole('row')).toHaveLength(3);
      expect(screen.getByRole('columnheader', { name: 'Sources' })).toBeInTheDocument();
      // Two body rows of three cells each, the third being Sources.
      expect(screen.getAllByRole('cell')).toHaveLength(6);
    });

    it('still parses as a table, which the delimiter row decides', () => {
      const { container } = renderCited(TABLE, [WHOLE_TABLE]);

      // A header row with more cells than the delimiter row has alignments stops being a
      // table entirely and renders as a paragraph of pipes.
      expect(container.querySelector('table')).not.toBeNull();
      expect(screen.getAllByRole('columnheader')).toHaveLength(3);
      expect(container.textContent).not.toContain('| ---');
    });

    it('puts the marker in a cell, still linked to the document', () => {
      renderCited(TABLE, [WHOLE_TABLE]);

      const marker = screen.getAllByRole('link', { name: '[1]' })[0];
      expect(marker?.closest('td')).not.toBeNull();
      expect(marker).toHaveAttribute('href', expect.stringContaining('/document?'));
    });

    it('marks only the row a single-row citation covers', () => {
      const rowStart = TABLE.indexOf('| Q1 2026');
      renderCited(TABLE, [citation(rowStart, rowStart + 17)]);

      const rows = screen.getAllByRole('row');
      // Row 0 is the header, so rows 1 and 2 are the body.
      expect(rows[1]?.textContent).not.toContain('[1]');
      expect(rows[2]?.textContent).toContain('[1]');
    });

    it('leaves an uncited table with no extra column', () => {
      renderCited(TABLE, []);

      expect(screen.getAllByRole('columnheader')).toHaveLength(2);
      expect(screen.queryByRole('columnheader', { name: 'Sources' })).toBeNull();
    });

    it('keeps prose after the table out of the table', () => {
      renderCited(TABLE, [WHOLE_TABLE]);

      const notes = screen.getByText('Notes follow.');
      expect(notes.closest('table')).toBeNull();
    });
  });

  describe('a cited code fence', () => {
    const FENCED = 'Example:\n\n```json\n{ "arr": 4.0 }\n```\n\nDone.';

    it('keeps the marker out of the code', () => {
      const { container } = renderCited(FENCED, [citation(0, FENCED.indexOf('"arr"'))]);

      const code = container.querySelector('code');
      expect(code?.textContent).toBe('{ "arr": 4.0 }\n');
      expect(screen.getByRole('link', { name: '[1]' }).closest('code')).toBeNull();
    });

    it('marks the marker paragraph so it can be styled as a source line', () => {
      renderCited(FENCED, [citation(0, FENCED.indexOf('"arr"'))]);

      const paragraph = screen.getByRole('link', { name: '[1]' }).closest('p');
      // Standing alone under a block, a bare bracket run reads as debris. The class is what
      // lets CSS present it as attribution instead.
      expect(paragraph?.className).not.toBe('');
    });

    /**
     * A block can be followed directly by prose with no blank line between. Without a blank
     * line *after* the displaced marker, that prose joins the marker's paragraph by lazy
     * continuation, so the citation ends up glued to a sentence it does not support.
     */
    it('does not absorb prose that follows the block immediately', () => {
      const tight = '```json\n{ "arr": 4.0 }\n```\nNotes follow.';
      renderCited(tight, [citation(0, tight.indexOf('"arr"'))]);

      const marker = screen.getByRole('link', { name: '[1]' });
      expect(marker.closest('p')?.textContent).not.toContain('Notes follow.');
    });
  });

  describe('prose', () => {
    it('takes the marker inline and is not styled as a source line', () => {
      renderCited('Revenue is up. Costs are flat.', [citation(0, 14)]);

      const paragraph = screen.getByRole('link', { name: '[1]' }).closest('p');
      expect(paragraph?.className).toBe('');
      expect(paragraph?.textContent).toContain('Revenue is up.');
    });
  });
});
