import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, type ApiClient } from '../api/client.ts';
import { DocumentView } from './DocumentView.tsx';

const ID = 's3://bucket/content/finance/q3-revenue-forecast.md';

interface StubOptions {
  readonly mimeType?: string;
  readonly body?: string;
  readonly contentError?: Error;
  readonly textError?: Error;
}

function stubApi(options: StubOptions = {}) {
  const documentContent = vi.fn(async () => {
    if (options.contentError !== undefined) throw options.contentError;
    return {
      mimeType: options.mimeType ?? 'text/plain',
      url: 'https://storage.example/signed',
      expiresInSeconds: 300,
    };
  });

  const documentText = vi.fn(async () => {
    if (options.textError !== undefined) throw options.textError;
    return options.body ?? '# Q3 Revenue Forecast\n\nRevenue is **up**.';
  });

  return { documentContent, documentText } as unknown as ApiClient;
}

function renderView(
  api: ApiClient,
  query = `?id=${encodeURIComponent(ID)}&source=DS1&title=q3-revenue-forecast.md`,
) {
  return render(
    <MemoryRouter initialEntries={[`/document${query}`]}>
      <Routes>
        <Route path="/document" element={<DocumentView api={api} />} />
        <Route path="/" element={<p>search screen</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DocumentView', () => {
  it('renders the document as Markdown', async () => {
    renderView(stubApi());

    expect(
      await screen.findByRole('heading', { name: 'Q3 Revenue Forecast', level: 4 }),
    ).toBeInTheDocument();
    expect(screen.getByText('up').tagName).toBe('STRONG');
  });

  it('requests the document with both identifiers from the link', async () => {
    const api = stubApi();
    renderView(api);
    await screen.findByText(/Revenue is/);

    expect(api.documentContent).toHaveBeenCalledWith(
      { documentId: ID, dataSourceId: 'DS1' },
      expect.anything(),
    );
  });

  it('shows the readable title and the full identifier', async () => {
    renderView(stubApi());
    await screen.findByText(/Revenue is/);

    // Readable for the reader, exact for whoever has to run `make acl-check`.
    expect(
      screen.getByRole('heading', { name: 'Q3 Revenue Forecast', level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByText(ID)).toBeInTheDocument();
  });

  /**
   * A document's text is corpus content, and corpus content is untrusted input.
   *
   * This screen is the only place a whole document reaches the DOM, so it is where the
   * Markdown component's refusal to evaluate raw HTML actually matters.
   */
  it('does not execute markup embedded in a document', async () => {
    const { container } = renderView(
      stubApi({ body: 'Before <img src=x onerror="alert(1)"> after' }),
    );
    await screen.findByText(/Before/);

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('onerror');
  });

  describe('when the document is not available', () => {
    /**
     * 404 covers "does not exist" and "you may not read it", and the API does not say
     * which. Neither does this screen — inventing a reason here would leak exactly the
     * distinction the API withholds.
     */
    it('says so without guessing why', async () => {
      renderView(stubApi({ contentError: new ApiError(404, 'Not available') }));

      const notice = await screen.findByText(/not available/i);
      expect(notice).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/denied|forbidden/i);
    });

    it('reports other failures as errors rather than as a missing document', async () => {
      renderView(
        stubApi({ contentError: new ApiError(502, 'Upstream request failed') }),
      );

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/upstream request failed/i);
      expect(screen.queryByText(/may not have permission/i)).not.toBeInTheDocument();
    });

    it('reports a failed download, which is usually an expired URL', async () => {
      renderView(
        stubApi({
          textError: new ApiError(403, 'The document could not be downloaded.'),
        }),
      );

      expect(await screen.findByRole('alert')).toHaveTextContent(/could not be/i);
    });
  });

  describe('content this screen cannot render', () => {
    it('offers a link instead of rendering bytes as text', async () => {
      const api = stubApi({ mimeType: 'application/pdf' });
      renderView(api);

      const link = await screen.findByRole('link', { name: /open the original/i });
      expect(link).toHaveAttribute('href', 'https://storage.example/signed');
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
      // No point downloading a PDF only to feed it to a Markdown renderer.
      expect(api.documentText).not.toHaveBeenCalled();
    });

    it('treats an unrecognised type as unrenderable rather than assuming text', async () => {
      const api = stubApi({ mimeType: 'application/octet-stream' });
      renderView(api);

      await screen.findByRole('link', { name: /open the original/i });
      expect(api.documentText).not.toHaveBeenCalled();
    });

    it('still renders text when the type carries a charset', async () => {
      const api = stubApi({ mimeType: 'text/markdown; charset=utf-8' });
      renderView(api);

      await screen.findByText(/Revenue is/);
      expect(api.documentText).toHaveBeenCalled();
    });
  });

  describe('a link with no document reference', () => {
    it('says the link is incomplete instead of requesting nothing', async () => {
      const api = stubApi();
      renderView(api, '?id=&source=');

      expect(await screen.findByRole('alert')).toHaveTextContent(/missing a document/i);
      expect(api.documentContent).not.toHaveBeenCalled();
    });
  });

  /**
   * Navigating from one document to another must not show the first one's text.
   *
   * This component stays mounted across that navigation, so an outcome held without the
   * document identifier it belongs to would render the previous body under the new
   * title for as long as the new fetch takes — a wrong document presented as the right
   * one, which for a permissioned corpus is the worst available bug.
   */
  it('does not show the previous document while the next one loads', async () => {
    const user = userEvent.setup();
    const release: { current?: () => void } = {};

    const api = {
      documentContent: vi.fn(async (request: { documentId: string }) => {
        if (request.documentId === 'second') {
          await new Promise<void>((resolve) => {
            release.current = resolve;
          });
        }
        return {
          mimeType: 'text/plain',
          url: `https://storage.example/${request.documentId}`,
          expiresInSeconds: 300,
        };
      }),
      documentText: vi.fn(async (url: string) =>
        url.endsWith('second') ? 'SECOND BODY' : 'FIRST BODY',
      ),
    } as unknown as ApiClient;

    render(
      <MemoryRouter initialEntries={['/document?id=first&source=DS1']}>
        <Routes>
          <Route
            path="/document"
            element={
              <>
                <DocumentView api={api} />
                <Link to="/document?id=second&source=DS1">go to second</Link>
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('FIRST BODY');
    await user.click(screen.getByRole('link', { name: 'go to second' }));

    // The second fetch is still in flight.
    expect(screen.queryByText('FIRST BODY')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);

    release.current?.();
    expect(await screen.findByText('SECOND BODY')).toBeInTheDocument();
  });

  it('offers a way back to search', async () => {
    renderView(stubApi());
    await screen.findByText(/Revenue is/);

    expect(screen.getByRole('link', { name: /back to search/i })).toHaveAttribute(
      'href',
      '/',
    );
  });
});
