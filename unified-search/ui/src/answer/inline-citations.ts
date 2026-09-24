import type { Citation, CitationReference } from '@domain';

/**
 * Turns span-based citations into inline `[n]` markers plus a numbered source list.
 *
 * Each citation is a character range in the answer plus the passages backing it. Rendering
 * that structure literally would mean a panel under the answer repeating a chunk of the
 * answer text, then the passage, then the document, for every claim, duplicating content
 * the reader has already read.
 *
 * Instead this marks each claim in place and lists the documents once.
 *
 * ## Three placements, because one does not fit every construct
 *
 * The answer is Markdown, so where a marker can go depends on what it lands in.
 *
 * - **Prose** takes the marker inline, as a Markdown link. `[[1]](<href>)` makes it a real
 *   link, so it inherits the renderer's link handling and needs no raw HTML. The angle
 *   brackets are CommonMark's escape for destinations containing characters that would
 *   otherwise end the link.
 * - **A table** gets a `Sources` column, and each row carries the markers for the citations
 *   covering it. A marker cannot go inside a row without adding a cell and corrupting the
 *   row, and putting it in a caption underneath costs a block of vertical space per
 *   citation, which on a multi-table answer dominates the page.
 * - **A code fence** takes neither, so its markers become a paragraph immediately after the
 *   block. Code has no cell to put them in and no safe position inside it.
 *
 * ## Why the whole thing is line-based
 *
 * Editing by absolute offset invalidates every later offset. Inserting back to front
 * handles that for plain text, but not once edits also add cells and paragraphs, because
 * those change line structure as well as length. So offsets are converted to line and
 * column once, up front, and every edit after that is local to a line.
 */

/** A document backing an answer, numbered by first appearance. */
export interface InlineSource {
  readonly number: number;
  readonly title: string;
  /** In-app viewer path, absent when the reference cannot be addressed. */
  readonly href?: string;
}

export interface InlineCitations {
  /** Answer text with markers inserted. */
  readonly text: string;
  /** Cited documents, numbered and deduplicated. */
  readonly sources: readonly InlineSource[];
}

/** Header used for the citation column added to a cited table. */
const SOURCES_COLUMN = 'Sources';

/**
 * Identity for deduplication.
 *
 * A document cited five times is one source, not five. Falls back through the fields most
 * likely to be unique, document id first, since that is what the ACL and content APIs key
 * on.
 */
function sourceKey(reference: CitationReference): string {
  return reference.documentId ?? reference.uri ?? reference.title ?? '';
}

/**
 * Viewer path for a cited document, or nothing if it cannot be opened.
 *
 * Requires both identifiers because the document content API requires both. Deliberately
 * does not fall back to `reference.uri`: for an S3 data source that is an object URL in a
 * private bucket, so it looks like a working link and answers with an access error.
 */
function viewerPath(reference: CitationReference): string | undefined {
  if (reference.documentId === undefined || reference.dataSourceId === undefined) {
    return undefined;
  }
  const params = new URLSearchParams({
    id: reference.documentId,
    source: reference.dataSourceId,
  });
  if (reference.title !== undefined) params.set('title', reference.title);
  return `/document?${params.toString()}`;
}

interface Line {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** A run of lines forming a GFM table: a header, a delimiter, then body rows. */
interface TableBlock {
  readonly kind: 'table';
  readonly first: number;
  readonly last: number;
}

/** A fenced code block, from its opening fence line to its closing one. */
interface FenceBlock {
  readonly kind: 'fence';
  readonly first: number;
  readonly last: number;
}

type Block = TableBlock | FenceBlock;

/**
 * Finds the line ranges of tables and code fences.
 *
 * A table needs at least a header and a delimiter row to be one, and a single `|` line is
 * not a table, so runs shorter than two lines are ignored. Unterminated blocks run to the
 * end of the answer, which is the normal state of a streaming response.
 */
function findBlocks(lines: readonly Line[]): readonly Block[] {
  const blocks: Block[] = [];
  let fenceFirst: number | undefined;
  let tableFirst: number | undefined;

  const closeTable = (lastIndex: number) => {
    if (tableFirst !== undefined) {
      if (lastIndex - tableFirst >= 1) {
        blocks.push({ kind: 'table', first: tableFirst, last: lastIndex });
      }
      tableFirst = undefined;
    }
  };

  lines.forEach((line, index) => {
    const trimmed = line.text.trim();

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      if (fenceFirst === undefined) {
        closeTable(index - 1);
        fenceFirst = index;
      } else {
        blocks.push({ kind: 'fence', first: fenceFirst, last: index });
        fenceFirst = undefined;
      }
      return;
    }

    if (fenceFirst !== undefined) return;

    if (trimmed.startsWith('|')) {
      tableFirst ??= index;
    } else {
      closeTable(index - 1);
    }
  });

  if (fenceFirst !== undefined) {
    blocks.push({ kind: 'fence', first: fenceFirst, last: lines.length - 1 });
  }
  closeTable(lines.length - 1);

  return blocks;
}

/** Adds a cell to a GFM row, tolerating rows written without outer pipes. */
function appendCell(row: string, content: string): string {
  const trimmed = row.trimEnd();
  return trimmed.endsWith('|') ? `${trimmed} ${content} |` : `${trimmed} | ${content}`;
}

export function withInlineCitations(
  text: string,
  citations: readonly Citation[],
): InlineCitations {
  const sources: InlineSource[] = [];
  const numberByKey = new Map<string, number>();

  /** Numbers this citation's references, registering any not seen before. */
  const numbersFor = (citation: Citation): number[] => {
    const numbers: number[] = [];
    for (const reference of citation.references) {
      const key = sourceKey(reference);
      if (key === '') continue;

      let number = numberByKey.get(key);
      if (number === undefined) {
        number = sources.length + 1;
        numberByKey.set(key, number);
        const href = viewerPath(reference);
        sources.push({
          number,
          title: reference.title ?? reference.documentId ?? reference.uri ?? 'Source',
          ...(href === undefined ? {} : { href }),
        });
      }
      if (!numbers.includes(number)) numbers.push(number);
    }
    return numbers;
  };

  const lines: Line[] = [];
  let offset = 0;
  for (const lineText of text.split('\n')) {
    lines.push({ text: lineText, start: offset, end: offset + lineText.length });
    offset += lineText.length + 1;
  }

  const blocks = findBlocks(lines);
  const blockAt = (lineIndex: number): Block | undefined =>
    blocks.find((block) => lineIndex >= block.first && lineIndex <= block.last);

  /** Inline insertions, keyed by line then column. */
  const inline = new Map<number, { column: number; numbers: number[] }[]>();
  /** Markers destined for a table row's Sources cell, keyed by line. */
  const rowMarkers = new Map<number, number[]>();
  /** Markers displaced to a paragraph after a block, keyed by the block's last line. */
  const afterBlock = new Map<number, number[]>();
  /** Tables that gained a Sources column, so the header and delimiter get one too. */
  const citedTables = new Set<TableBlock>();

  const addAll = (
    map: Map<number, number[]>,
    key: number,
    numbers: readonly number[],
  ) => {
    const existing = map.get(key) ?? [];
    for (const number of numbers) if (!existing.includes(number)) existing.push(number);
    map.set(key, existing);
  };

  for (const citation of citations) {
    const numbers = numbersFor(citation);
    if (numbers.length === 0) continue;

    const endLine = Math.max(
      0,
      lines.findLastIndex(
        (line) => line.start <= Math.min(citation.span.end, text.length),
      ),
    );
    const block = blockAt(endLine);

    if (block?.kind === 'table') {
      // Body rows start after the header and delimiter. A table with none has nowhere to
      // put a cell, so its markers fall back to a paragraph underneath.
      const firstBody = block.first + 2;
      if (firstBody > block.last) {
        addAll(afterBlock, block.last, numbers);
        continue;
      }

      citedTables.add(block);

      // Every body row the citation covers, which is how a citation over a whole table ends
      // up marked on each of its rows rather than once at the bottom.
      const covered: number[] = [];
      for (let index = firstBody; index <= block.last; index += 1) {
        const line = lines[index];
        if (line === undefined) continue;
        if (citation.span.start <= line.end && citation.span.end >= line.start) {
          covered.push(index);
        }
      }

      for (const index of covered.length > 0 ? covered : [firstBody]) {
        addAll(rowMarkers, index, numbers);
      }
      continue;
    }

    if (block?.kind === 'fence') {
      addAll(afterBlock, block.last, numbers);
      continue;
    }

    const line = lines[endLine];
    if (line === undefined) continue;
    const column = Math.max(0, Math.min(citation.span.end, line.end) - line.start);
    inline.set(endLine, [...(inline.get(endLine) ?? []), { column, numbers }]);
  }

  const hrefByNumber = new Map(sources.map((source) => [source.number, source.href]));
  const marker = (number: number): string => {
    const href = hrefByNumber.get(number);
    // An unaddressable source still gets a number, so the source list and the answer agree.
    // Plain text rather than a link that cannot work.
    return href === undefined
      ? `[${String(number)}]`
      : `[[${String(number)}]](<${href}>)`;
  };
  const markers = (numbers: readonly number[]): string => numbers.map(marker).join('');

  const output: string[] = [];

  lines.forEach((line, index) => {
    let rendered = line.text;

    // Columns are inserted last-first so earlier columns stay valid within the line.
    for (const insertion of (inline.get(index) ?? []).sort(
      (a, b) => b.column - a.column,
    )) {
      const at = Math.min(insertion.column, rendered.length);
      const needsSpace = at > 0 && !/\s/.test(rendered[at - 1] ?? '');
      rendered = `${rendered.slice(0, at)}${needsSpace ? ' ' : ''}${markers(insertion.numbers)}${rendered.slice(at)}`;
    }

    const table = blocks.find(
      (block): block is TableBlock =>
        block.kind === 'table' && index >= block.first && index <= block.last,
    );

    if (table !== undefined && citedTables.has(table)) {
      if (index === table.first) {
        rendered = appendCell(rendered, SOURCES_COLUMN);
      } else if (index === table.first + 1) {
        // The delimiter row has to gain a column too, or the table has more headers than
        // alignments and stops parsing as a table at all.
        rendered = appendCell(rendered, '---');
      } else {
        rendered = appendCell(rendered, markers(rowMarkers.get(index) ?? []));
      }
    }

    output.push(rendered);

    const displaced = afterBlock.get(index);
    if (displaced !== undefined) {
      // Blank lines on both sides. Only a blank line ends a GFM table, and the trailing one
      // stops the next block being pulled into this paragraph by lazy continuation.
      output.push('', markers(displaced), '');
    }
  });

  return { text: output.join('\n'), sources };
}
