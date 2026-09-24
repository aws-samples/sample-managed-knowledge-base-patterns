import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { render } from '../test/render.tsx';

import type { ChatEvent, SearchPage } from '@domain';

import { ApiError, ChatStreamError, type ApiClient } from '../api/client.ts';
import { CombinedSearchPage } from './CombinedSearchPage.tsx';

function hit(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    snippet: `Snippet for ${id}`,
    sourceType: 's3' as const,
    metadata: {},
    ...overrides,
  };
}

const answer = (text: string): ChatEvent => ({ kind: 'answer', text });

/**
 * An answer that cited a source — the "found something relevant" case.
 *
 * Citations are the relevance signal on this screen: similarity scores order results within
 * one response rather than acting as an absolute cutoff, so an answer that cites nothing is
 * what marks a search as having found nothing closely related. Tests therefore have to say
 * which of the two cases they are in.
 */
function citedAnswer(text: string): readonly ChatEvent[] {
  return [
    { kind: 'answer', text },
    {
      kind: 'citations',
      citations: [
        {
          span: { start: 0, end: text.length },
          text,
          references: [{ snippet: 'source text', sourceType: 's3' }],
        },
      ],
    },
  ];
}

interface StubOptions {
  readonly page?: SearchPage;
  readonly searchError?: Error;
  readonly events?: readonly ChatEvent[];
  readonly chatError?: Error;
  /** Resolves the search only when this is called, to test parallelism. */
  readonly holdSearch?: { release: () => void };
  /** Withholds the final chat event until this is called, to test mid-stream state. */
  readonly holdChat?: { release: () => void };
}

function stubApi(options: StubOptions = {}): ApiClient {
  const search = vi.fn(async () => {
    if (options.holdSearch !== undefined) {
      await new Promise<void>((resolve) => {
        options.holdSearch!.release = resolve;
      });
    }
    if (options.searchError !== undefined) throw options.searchError;
    return options.page ?? { hits: [] };
  });

  const chat = vi.fn(function (): AsyncGenerator<ChatEvent> {
    async function* stream(): AsyncGenerator<ChatEvent> {
      const events = options.events ?? [];
      for (const [index, event] of events.entries()) {
        if (options.holdChat !== undefined && index === events.length - 1) {
          await new Promise<void>((resolve) => {
            options.holdChat!.release = resolve;
          });
        }
        await Promise.resolve();
        yield event;
      }
      if (options.chatError !== undefined) throw options.chatError;
    }
    return stream();
  });

  return { search, chat } as unknown as ApiClient;
}

async function searchFor(text: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(
    screen.getByRole('searchbox', { name: /search your documents/i }),
    text,
  );
  await user.click(screen.getByRole('button', { name: 'Search' }));
}

describe('CombinedSearchPage', () => {
  it('shows a generated answer above the matching documents', async () => {
    render(
      <CombinedSearchPage
        api={stubApi({
          events: [answer('Revenue is $4.2 million.')],
          page: { hits: [hit('doc-1', { title: 'Q3 Forecast' })] },
        })}
      />,
    );

    await searchFor('revenue');

    expect(await screen.findByText('Revenue is $4.2 million.')).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Q3 Forecast' }),
    ).toBeInTheDocument();

    // Order matters: this is the shape the layout exists to provide.
    const answerNode = screen.getByText('Revenue is $4.2 million.');
    const resultNode = screen.getByRole('heading', { name: 'Q3 Forecast' });
    expect(answerNode.compareDocumentPosition(resultNode)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  /**
   * The two halves are issued together, not in sequence, so each half appears as soon as it
   * is ready rather than one waiting on the other.
   */
  it('issues both requests without waiting for either', async () => {
    const api = stubApi({ events: [answer('done')] });

    render(<CombinedSearchPage api={api} />);
    await searchFor('revenue');

    await waitFor(() => {
      expect(api.search).toHaveBeenCalledTimes(1);
      expect(api.chat).toHaveBeenCalledTimes(1);
    });
  });

  it('renders the answer while the result list is still pending', async () => {
    const hold = { release: () => {} };
    render(
      <CombinedSearchPage
        api={stubApi({
          events: [answer('Early answer.')],
          holdSearch: hold,
          page: { hits: [hit('d')] },
        })}
      />,
    );

    await searchFor('revenue');

    // The answer is on screen while the search is still outstanding.
    expect(await screen.findByText('Early answer.')).toBeInTheDocument();
    expect(screen.queryByText('Snippet for d')).not.toBeInTheDocument();

    hold.release();
    expect(await screen.findByText('Snippet for d')).toBeInTheDocument();
  });

  /**
   * Each half fails on its own. One failing must not blank the other, because the half
   * that worked is still useful.
   */
  describe('partial failure', () => {
    it('keeps the answer when the document search fails', async () => {
      render(
        <CombinedSearchPage
          api={stubApi({
            events: [answer('Answer survived.')],
            searchError: new ApiError(502, 'Upstream request failed.'),
          })}
        />,
      );

      await searchFor('revenue');

      expect(await screen.findByText('Answer survived.')).toBeInTheDocument();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /upstream request failed/i,
      );
    });

    it('keeps the documents when the answer fails', async () => {
      render(
        <CombinedSearchPage
          api={stubApi({
            chatError: new ApiError(502, 'Generation is unavailable.'),
            page: { hits: [hit('doc-1')] },
          })}
        />,
      );

      await searchFor('revenue');

      expect(await screen.findByText('Snippet for doc-1')).toBeInTheDocument();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /generation is unavailable/i,
      );
    });

    it('marks a truncated answer as incomplete while keeping the documents', async () => {
      render(
        <CombinedSearchPage
          api={stubApi({
            events: [answer('Half an ')],
            chatError: new ChatStreamError(
              'The response stream closed early, so some details may be missing. Try asking again.',
            ),
            page: { hits: [hit('doc-1')] },
          })}
        />,
      );

      await searchFor('revenue');

      // The server commits to 200 before it knows the answer will succeed, so a truncated
      // stream is content rather than an error. Rendering it silently would present an
      // incomplete answer as a complete one.
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /this answer is incomplete/i,
      );
      expect(screen.getByText('Snippet for doc-1')).toBeInTheDocument();
    });
  });

  /**
   * Semantic retrieval ranks by similarity and returns the nearest matches, so a query about
   * baseball against business documents still returns business documents. Scores order
   * results within one response rather than acting as an absolute cutoff, so this screen
   * uses the answer's citations as the relevance signal, which is what these assert.
   */
  describe('when nothing relevant was found', () => {
    it('says the documents are closest by similarity, not matches', async () => {
      render(<CombinedSearchPage api={stubApi({ page: { hits: [hit('doc-1')] } })} />);

      await searchFor('baseball');

      expect(
        await screen.findByText(/didn't cite any of these documents/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /closest documents/i }),
      ).toBeInTheDocument();
      expect(screen.getByText(/1 closest document by similarity/i)).toBeInTheDocument();
    });

    it('presents them as matches when the answer did cite a source', async () => {
      render(
        <CombinedSearchPage
          api={stubApi({
            page: { hits: [hit('doc-1')] },
            events: citedAnswer('Answer.'),
          })}
        />,
      );

      await searchFor('revenue');
      await screen.findByRole('heading', { name: /matching documents/i });

      expect(
        screen.queryByText(/didn't cite any of these documents/i),
      ).not.toBeInTheDocument();
    });

    it('does not claim nothing matched while the answer is still streaming', async () => {
      const hold = { release: () => {} };
      render(
        <CombinedSearchPage
          api={stubApi({
            page: { hits: [hit('doc-1')] },
            events: citedAnswer('Answer text.'),
            holdChat: hold,
          })}
        />,
      );

      await searchFor('revenue');

      // The answer text has arrived and the documents are on screen, but citations have
      // not. Reading relevance now would flash the warning on every single search.
      await screen.findByText('Answer text.');
      await screen.findByText('Snippet for doc-1');
      expect(
        screen.queryByText(/didn't cite any of these documents/i),
      ).not.toBeInTheDocument();

      hold.release();
      // And once the citations land it stays absent for the right reason, not by timing.
      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: /matching documents/i }),
        ).toBeInTheDocument();
      });
    });

    it('does not claim nothing matched when the answer was merely truncated', async () => {
      render(
        <CombinedSearchPage
          api={stubApi({
            events: [answer('partial')],
            chatError: new ChatStreamError('ended early'),
            page: { hits: [hit('doc-1')] },
          })}
        />,
      );

      await searchFor('revenue');
      await screen.findByText(/this answer is incomplete/i);

      // An interrupted answer has no citations for a different reason. Reporting "nothing
      // matched" there would be a second, wrong explanation for one failure.
      expect(
        screen.queryByText(/didn't cite any of these documents/i),
      ).not.toBeInTheDocument();
    });
  });

  it('explains that no documents may mean no permission', async () => {
    render(<CombinedSearchPage api={stubApi({ page: { hits: [] } })} />);

    await searchFor('revenue');

    // "Nothing matched" and "you may not see what matched" are not distinguished, by design,
    // so access isn't revealed. Both readings are stated.
    expect(await screen.findByText(/may not be shared with you/i)).toBeInTheDocument();
  });

  describe('the query in the URL', () => {
    it('runs the query from the URL on arrival', async () => {
      const api = stubApi({ page: { hits: [hit('doc-1')] }, events: [answer('done')] });
      render(<CombinedSearchPage api={api} />, { route: '/?q=revenue' });

      // Leaving this screen and coming back restores the search rather than an empty box.
      await waitFor(() => {
        expect(api.search).toHaveBeenCalledWith(
          expect.objectContaining({ text: 'revenue' }),
          expect.anything(),
        );
      });
      expect(
        screen.getByRole('searchbox', { name: /search your documents/i }),
      ).toHaveValue('revenue');
    });

    it('runs the URL query once, not on every render', async () => {
      const api = stubApi({ page: { hits: [hit('doc-1')] }, events: [answer('done')] });
      render(<CombinedSearchPage api={api} />, { route: '/?q=revenue' });

      await screen.findByText('Snippet for doc-1');
      await waitFor(() => {
        expect(api.search).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('collapsing a half', () => {
    const bothHalves = () =>
      stubApi({
        page: { hits: [hit('doc-1')] },
        events: citedAnswer('Answer text.'),
      });

    /**
     * Collapsing is display only, and both halves are always requested.
     *
     * Skipping the request for a hidden half would make collapsing destructive: expanding
     * again would require a new search. The point of the control is reading the results you
     * already have, usually to look at the document list without the answer above it.
     */
    it('keeps the answer available after collapsing and expanding', async () => {
      const user = userEvent.setup();
      const api = bothHalves();
      render(<CombinedSearchPage api={api} />);

      await searchFor('revenue');
      await screen.findByText('Answer text.');

      await user.click(screen.getByRole('button', { name: /hide answer/i }));
      expect(screen.getByText('Answer text.')).not.toBeVisible();

      await user.click(screen.getByRole('button', { name: /show answer/i }));
      expect(screen.getByText('Answer text.')).toBeVisible();

      // One search, one generation. Collapsing did not re-ask anything.
      expect(api.chat).toHaveBeenCalledTimes(1);
      expect(api.search).toHaveBeenCalledTimes(1);
    });

    it('collapses the documents independently of the answer', async () => {
      const user = userEvent.setup();
      render(<CombinedSearchPage api={bothHalves()} />);

      await searchFor('revenue');
      await screen.findByText('Snippet for doc-1');

      await user.click(screen.getByRole('button', { name: /hide documents/i }));

      expect(screen.getByText('Snippet for doc-1')).not.toBeVisible();
      expect(screen.getByText('Answer text.')).toBeVisible();
    });

    it('keeps both halves requested regardless of collapse state', async () => {
      const user = userEvent.setup();
      const api = bothHalves();
      render(<CombinedSearchPage api={api} />);

      await searchFor('revenue');
      await screen.findByText('Answer text.');
      await user.click(screen.getByRole('button', { name: /hide answer/i }));
      await user.click(screen.getByRole('button', { name: 'Search' }));

      await waitFor(() => {
        expect(api.chat).toHaveBeenCalledTimes(2);
        expect(api.search).toHaveBeenCalledTimes(2);
      });
    });

    it('stays collapsed across searches', async () => {
      const user = userEvent.setup();
      render(<CombinedSearchPage api={bothHalves()} />);

      await searchFor('revenue');
      await screen.findByText('Answer text.');
      await user.click(screen.getByRole('button', { name: /hide answer/i }));
      await user.click(screen.getByRole('button', { name: 'Search' }));

      // Re-expanding on every search would make the control useless for its actual purpose,
      // which is reading a list of documents across several queries.
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /show answer/i }),
        ).toBeInTheDocument();
      });
    });

    /**
     * The control has to say which region it governs and whether that region is open, or a
     * screen reader user gets two buttons called "Hide" and no way to tell what happened.
     */
    it('wires the control to the region it collapses', async () => {
      const user = userEvent.setup();
      render(<CombinedSearchPage api={bothHalves()} />);

      await searchFor('revenue');
      await screen.findByText('Answer text.');

      const toggle = screen.getByRole('button', { name: /hide answer/i });
      expect(toggle).toHaveAttribute('aria-expanded', 'true');

      const region = document.getElementById(
        toggle.getAttribute('aria-controls') ?? '',
      );
      expect(region).not.toBeNull();
      expect(region).toContainElement(screen.getByText('Answer text.'));

      await user.click(toggle);
      expect(screen.getByRole('button', { name: /show answer/i })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    });

    it('does not discard an answer collapsed while it is still streaming', async () => {
      const user = userEvent.setup();
      const hold = { release: () => {} };
      render(
        <CombinedSearchPage
          api={stubApi({
            page: { hits: [hit('doc-1')] },
            events: citedAnswer('Answer text.'),
            holdChat: hold,
          })}
        />,
      );

      await searchFor('revenue');
      await screen.findByText('Answer text.');

      await user.click(screen.getByRole('button', { name: /hide answer/i }));
      hold.release();
      await user.click(screen.getByRole('button', { name: /show answer/i }));

      // Hidden rather than unmounted, so the stream kept writing into a live component.
      expect(screen.getByText('Answer text.')).toBeVisible();
    });
  });
  it('does not show a relevance score on results', async () => {
    render(
      <CombinedSearchPage
        api={stubApi({ page: { hits: [hit('doc-1', { score: 0.3646 })] } })}
      />,
    );

    await searchFor('revenue');
    await screen.findByText('Snippet for doc-1');

    // Scores are a relative ordering within one response, and the list is already sorted,
    // so the number adds no information for the reader. See ResultList.
    expect(screen.queryByText(/relevance/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/0\.36/)).not.toBeInTheDocument();
  });

  it('shows the folder a document came from, which is the access boundary', async () => {
    render(
      <CombinedSearchPage
        api={stubApi({
          page: {
            hits: [
              hit('doc-1', { uri: 'https://b.s3.amazonaws.com/content/finance/q3.md' }),
            ],
          },
        })}
      />,
    );

    await searchFor('revenue');

    expect(await screen.findByText('finance')).toBeInTheDocument();
  });

  it('sends no conversationId, so this screen writes nothing to memory', async () => {
    const api = stubApi({ events: [answer('done')] });

    render(<CombinedSearchPage api={api} />);
    await searchFor('revenue');

    await waitFor(() => {
      expect(api.chat).toHaveBeenCalledWith({ message: 'revenue' }, expect.anything());
    });
  });

  describe('example queries', () => {
    it('offers starting points before anything has been searched', () => {
      render(<CombinedSearchPage api={stubApi()} />);

      expect(
        screen.getByRole('button', { name: /projected quarterly revenue/i }),
      ).toBeInTheDocument();
    });

    it('runs an example when clicked, and stops offering them afterwards', async () => {
      const api = stubApi({ events: [answer('done')], page: { hits: [hit('doc-1')] } });
      render(<CombinedSearchPage api={api} />);

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: /projected quarterly revenue/i }));

      await waitFor(() => {
        expect(api.search).toHaveBeenCalledTimes(1);
      });
      expect(
        screen.queryByRole('button', { name: /projected quarterly revenue/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('labels the search field and wires the status region to it', () => {
      render(<CombinedSearchPage api={stubApi()} />);

      const input = screen.getByRole('searchbox', { name: /search your documents/i });
      expect(input.getAttribute('aria-describedby')).toBe(
        screen.getByRole('status').getAttribute('id'),
      );
    });

    it('announces the document count in a live region', async () => {
      render(
        <CombinedSearchPage
          api={stubApi({
            page: { hits: [hit('doc-1')] },
            events: citedAnswer('Answer.'),
          })}
        />,
      );

      await searchFor('revenue');

      const status = await screen.findByRole('status');
      expect(status).toHaveAttribute('aria-live', 'polite');
      await waitFor(() => {
        expect(status).toHaveTextContent('1 document matched');
      });
    });

    /**
     * One live region per view.
     *
     * The "nothing closely matched" note is plain text rather than a second `role="status"`,
     * so a screen reader does not announce both in an order neither controls. The single
     * live region carries the message.
     */
    it('keeps exactly one live region, even when nothing closely matched', async () => {
      render(<CombinedSearchPage api={stubApi({ page: { hits: [hit('doc-1')] } })} />);

      await searchFor('baseball');
      await screen.findByText(/didn't cite any of these documents/i);

      expect(screen.getAllByRole('status')).toHaveLength(1);
      expect(screen.getByRole('status')).toHaveTextContent(/no cited matches/i);
    });

    it('says nothing about results before a search has run', () => {
      render(<CombinedSearchPage api={stubApi()} />);

      // An empty state must not read as "no results found".
      expect(screen.getByRole('status')).toHaveTextContent('');
    });

    it('can be driven from the keyboard', async () => {
      const user = userEvent.setup();
      render(<CombinedSearchPage api={stubApi({ page: { hits: [hit('doc-1')] } })} />);

      await user.tab();
      expect(screen.getByRole('searchbox')).toHaveFocus();
      await user.keyboard('revenue{Enter}');

      expect(await screen.findByText('Snippet for doc-1')).toBeInTheDocument();
    });

    it('disables submission for an empty query', () => {
      render(<CombinedSearchPage api={stubApi()} />);

      expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
    });
  });
});
