import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { Markdown } from './Markdown';

describe('Markdown', () => {
  it('renders structure instead of syntax', () => {
    render(<Markdown>{'## Summary\n\nRevenue is **up**.\n\n- one\n- two'}</Markdown>);

    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByText('up').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    // The point of rendering at all: the reader never sees the markers.
    expect(screen.queryByText(/##/)).not.toBeInTheDocument();
  });

  /**
   * Answer text is derived from retrieved documents, and retrieved text is untrusted.
   *
   * This is the test that fails if someone adds `rehype-raw` or reaches for
   * `dangerouslySetInnerHTML` to "fix" a document that contains markup.
   */
  it('leaves HTML embedded in a document inert', () => {
    const { container } = render(
      <Markdown>
        {'Before <img src="x" onerror="window.__injected = true"> after\n\n' +
          '<script>window.__injected = true;</script>'}
      </Markdown>,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    // The markup is escaped, so `onerror` is a character sequence and not an attribute.
    expect(container.innerHTML).toContain('&lt;img');
    expect(container.innerHTML).toContain('&lt;script&gt;');
    // Inert, not silently dropped: the reader still sees what the document said.
    expect(container.textContent).toContain('onerror');
  });

  /**
   * An in-app link has to be a router navigation, not an anchor.
   *
   * The ID token is held in memory only, so a full page load lands the reader signed out and
   * bounces them to the identity provider. Citation markers are in-app links, so an anchor
   * here breaks following a citation, which is the whole point of having one.
   *
   * Clicking distinguishes the two: React Router navigates, and jsdom does not implement
   * navigation for a plain anchor, so the destination never renders.
   */
  it('navigates in-app links through the router rather than reloading', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <Markdown>
                {'Revenue is up [[1]](</document?id=abc&source=DS1>)'}
              </Markdown>
            }
          />
          <Route path="/document" element={<p>viewer opened</p>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('link', { name: '[1]' }));

    expect(await screen.findByText('viewer opened')).toBeInTheDocument();
  });

  it('styles a bracketed-number link as a citation marker', () => {
    render(
      <MemoryRouter>
        <Markdown>
          {
            'Claim [[1]](</document?id=abc&source=DS1>) and [more](</document?id=z&source=DS1>)'
          }
        </Markdown>
      </MemoryRouter>,
    );

    // Marker and ordinary in-app link are both router links, but only the marker is styled
    // as one, because only its text is a bracketed number.
    const marker = screen.getByRole('link', { name: '[1]' });
    const ordinary = screen.getByRole('link', { name: 'more' });
    expect(marker.className).not.toBe('');
    expect(ordinary.className).toBe('');
  });

  it('marks links from documents as untrusted destinations', () => {
    render(<Markdown>{'See [the report](https://example.com/r).'}</Markdown>);

    const link = screen.getByRole('link', { name: 'the report' });
    expect(link).toHaveAttribute('href', 'https://example.com/r');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
  });

  /**
   * CommonMark has no tables, and the generator emits them often because the corpus is full
   * of quarterly figures. Without `remark-gfm` these render as a wall of pipes.
   */
  it('renders GitHub-flavoured tables', () => {
    render(
      <Markdown>
        {'| Period | ARR |\n| --- | --- |\n| Q2 2025 | 4.0 |\n| Q1 2026 | 9.2 |'}
      </Markdown>,
    );

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Period' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'ARR' })).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('cell', { name: 'Q1 2026' })).toBeInTheDocument();
    // The failure mode this guards against: pipes surviving as literal text.
    expect(screen.queryByText(/\| --- \|/)).not.toBeInTheDocument();
  });

  it('renders the other GFM constructs the generator uses', () => {
    const { container } = render(
      <Markdown>{'~~withdrawn~~ and https://example.com/report'}</Markdown>,
    );

    expect(container.querySelector('del')).not.toBeNull();
    expect(
      screen.getByRole('link', { name: 'https://example.com/report' }),
    ).toHaveAttribute('href', 'https://example.com/report');
  });

  /**
   * The panel around this already owns a heading. A model-authored `#` must not outrank
   * it, or the document outline a screen reader reads becomes wrong.
   */
  it('demotes model headings below the surrounding panel heading', () => {
    render(<Markdown>{'# Top\n\n## Second\n\n### Third'}</Markdown>);

    expect(screen.getByRole('heading', { name: 'Top' }).tagName).toBe('H4');
    expect(screen.getByRole('heading', { name: 'Second' }).tagName).toBe('H4');
    expect(screen.getByRole('heading', { name: 'Third' }).tagName).toBe('H5');
  });
});
