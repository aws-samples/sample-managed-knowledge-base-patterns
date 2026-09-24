import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { readableTitle } from './readable-title.ts';
import { ResultList } from './ResultList.tsx';

function hit(overrides: Record<string, unknown> = {}) {
  return {
    id: 's3://bucket/content/finance/q3.md',
    snippet: 'Projected revenue is up.',
    sourceType: 's3' as const,
    metadata: {},
    ...overrides,
  };
}

/** Titles link into the app now, so a router has to be present. */
function renderList(hits: ReturnType<typeof hit>[], caption?: string) {
  return render(
    <MemoryRouter>
      <ResultList hits={hits} {...(caption === undefined ? {} : { caption })} />
    </MemoryRouter>,
  );
}

/**
 * `_document_title` contains the source file name, so the readable form is derived here,
 * and derived lossily on purpose.
 */
describe('readableTitle', () => {
  it('turns a file name into a readable title', () => {
    expect(readableTitle('platform-roadmap-q3-2026-4.md')).toBe(
      'Platform Roadmap Q3 2026',
    );
  });

  it('uppercases quarters rather than title-casing them', () => {
    expect(readableTitle('annual-plan-forecast-q1-2025-2.md')).toBe(
      'Annual Plan Forecast Q1 2025',
    );
  });

  it('leaves an already-readable title alone apart from the extension', () => {
    // If a connector ever supplies a real title, this must not mangle it.
    expect(readableTitle('Q3 Revenue Forecast.md')).toBe('Q3 Revenue Forecast');
    expect(readableTitle('Employee Handbook')).toBe('Employee Handbook');
  });

  it('handles underscores as well as hyphens', () => {
    expect(readableTitle('platform_roadmap_q2.md')).toBe('Platform Roadmap Q2');
  });

  it('returns undefined for nothing usable, so the caller can fall back', () => {
    expect(readableTitle(undefined)).toBeUndefined();
    expect(readableTitle('   ')).toBeUndefined();
  });

  it('does not invent words that were not in the file name', () => {
    const output = readableTitle('cost-optimization-budget-review-q4-2024-9.md') ?? '';

    for (const word of ['Cost', 'Optimization', 'Budget', 'Review']) {
      expect(output).toContain(word);
    }
    expect(output.split(' ')).toHaveLength(6);
  });
});

describe('ResultList', () => {
  it('renders nothing for an empty result set', () => {
    const { container } = renderList([]);

    // The caller decides what an empty state says; this must not render a stray caption.
    expect(container).toBeEmptyDOMElement();
  });

  /**
   * The link goes to the in-app viewer, not to the connector's own URL.
   *
   * `hit.uri` for an S3 data source is an object URL in a private bucket that correctly
   * denies direct access. The viewer route re-checks access server-side and renders the
   * document through an access-checked presigned URL.
   */
  it('links to the in-app document viewer, carrying both identifiers', () => {
    renderList([
      hit({
        title: 'q3-forecast.md',
        uri: 'https://example.test/q3.md',
        dataSourceId: 'DS1',
      }),
    ]);

    const link = screen.getByRole('link', { name: 'Q3 Forecast' });
    const href = link.getAttribute('href') ?? '';
    const [path, query] = href.split('?');
    const params = new URLSearchParams(query);

    expect(path).toBe('/document');
    expect(params.get('id')).toBe('s3://bucket/content/finance/q3.md');
    expect(params.get('source')).toBe('DS1');
    // Not the private bucket URL, which denies direct access.
    expect(href).not.toContain('example.test');
  });

  /**
   * A hit that cannot be addressed gets no link at all.
   *
   * Falling back to `hit.uri` would produce a link to a private bucket that denies direct
   * access, so a plain heading is clearer.
   */
  it('renders a plain heading when the data source is unknown', () => {
    renderList([hit({ title: 'q3-forecast.md', uri: 'https://example.test/q3.md' })]);

    expect(screen.getByRole('heading', { name: 'Q3 Forecast' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('falls back to the identifier when there is no title or uri', () => {
    renderList([hit()]);

    expect(
      screen.getByRole('heading', { name: 's3://bucket/content/finance/q3.md' }),
    ).toBeInTheDocument();
  });

  it('shows the folder, which is the access boundary in the sample corpus', () => {
    renderList([hit({ uri: 'https://b/content/security/threat.md' })]);

    expect(screen.getByText('security')).toBeInTheDocument();
  });

  it('omits the folder when the location shape is unfamiliar', () => {
    // A connector this build has never seen must not break the row.
    render(
      <ResultList hits={[hit({ uri: 'https://example.test/some/other/shape.md' })]} />,
    );

    expect(screen.getByRole('heading')).toBeInTheDocument();
  });

  /**
   * The score is not shown at all, and that is a decision rather than an omission.
   *
   * Scores express relative ordering within one response and aren't calibrated for
   * comparison across queries. The list is already sorted, so the number would add no
   * information and could be misread as a percentage.
   */
  it('never renders a relevance score, even when the provider reports one', () => {
    renderList([hit({ score: 0.8231 })]);

    expect(screen.queryByText(/relevance/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/0\.82/)).not.toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('renders the caption when given one', () => {
    renderList([hit()], '20 documents you have access to');

    expect(screen.getByText('20 documents you have access to')).toBeInTheDocument();
  });
});
