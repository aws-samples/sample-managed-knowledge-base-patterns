import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { render } from '../test/render.tsx';

import type { ChatEvent } from '@domain';

import { ApiError, ChatStreamError, type ApiClient } from '../api/client.ts';
import { ChatPage } from './ChatPage.tsx';

/** Builds a client whose chat yields the given events, optionally then throwing. */
function stubApi(events: readonly ChatEvent[], throwAtEnd?: Error): ApiClient {
  return {
    chat: async function* () {
      for (const event of events) {
        await Promise.resolve();
        yield event;
      }
      if (throwAtEnd !== undefined) throw throwAtEnd;
    },
  } as unknown as ApiClient;
}

const answer = (text: string): ChatEvent => ({ kind: 'answer', text });

/** A chat mock that records the request it was given, typed so calls can be asserted. */
function recordingChat() {
  return vi.fn((_request: { message: string; conversationId?: string }) => {
    async function* stream(): AsyncGenerator<ChatEvent> {
      await Promise.resolve();
      yield answer('hi');
    }
    return stream();
  });
}

async function ask(question = 'What is the revenue forecast?'): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: /ask a question/i }), question);
  await user.click(screen.getByRole('button', { name: 'Ask' }));
}

describe('ChatPage', () => {
  it('concatenates streamed answer deltas in order', async () => {
    render(
      <ChatPage
        api={stubApi([answer('Projected Q3 revenue is '), answer('$4.2 million.')])}
        conversationMemory={false}
      />,
    );

    await ask();

    // Citation spans index into this string, so order and completeness matter.
    expect(
      await screen.findByText('Projected Q3 revenue is $4.2 million.'),
    ).toBeInTheDocument();
  });

  it('marks the cited claim inline and lists the document once', async () => {
    render(
      <ChatPage
        api={stubApi([
          answer('Revenue is $4.2 million.'),
          {
            kind: 'citations',
            citations: [
              {
                span: { start: 0, end: 24 },
                text: 'Revenue is $4.2 million.',
                references: [
                  {
                    snippet: 'Q3 revenue: $4.2m',
                    sourceType: 's3',
                    title: 'q3-revenue-forecast.md',
                    documentId: 's3://bucket/content/finance/q3-revenue-forecast.md',
                    dataSourceId: 'DS1',
                    uri: 'https://example.test/q3.md',
                  },
                ],
              },
            ],
          },
        ])}
        conversationMemory={false}
      />,
    );

    await ask();

    // The marker sits in the answer text, which is how the reader ties a claim to a source
    // without a second copy of the sentence underneath.
    const marker = await screen.findByRole('link', { name: '[1]' });
    expect(marker).toHaveAttribute('href', expect.stringContaining('/document?'));

    // And the document is listed once, by name, rather than per citation.
    expect(screen.getByRole('heading', { name: /sources/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Q3 Revenue Forecast' })).toHaveAttribute(
      'href',
      expect.stringContaining('/document?'),
    );

    // The source list shows documents only, not passage text.
    expect(screen.queryByText('Q3 revenue: $4.2m')).not.toBeInTheDocument();
  });

  it('says when an answer cited nothing', async () => {
    render(
      <ChatPage
        api={stubApi([answer('I could not find that.')])}
        conversationMemory={false}
      />,
    );

    await ask();

    // An answer without citations isn't linked to a retrieved document, which is worth
    // telling the reader.
    expect(await screen.findByText(/no sources were cited/i)).toBeInTheDocument();
  });

  it('shows the agent reasoning steps', async () => {
    render(
      <ChatPage
        api={stubApi([
          {
            kind: 'trace',
            trace: { label: 'Retrieval', detail: 'sub-query: revenue' },
          },
          answer('Done.'),
        ])}
        conversationMemory={false}
      />,
    );

    await ask();

    expect(await screen.findByText(/how this answer was found/i)).toBeInTheDocument();
    expect(screen.getByText(/sub-query: revenue/)).toBeInTheDocument();
  });

  /**
   * The failure this screen exists to make visible.
   *
   * The server commits to 200 before it knows the answer will succeed, so a truncated
   * stream is not an HTTP error. Rendering the partial answer without saying so presents
   * an incomplete answer as a complete one.
   */
  describe('an incomplete answer', () => {
    it('keeps the partial answer and says it is incomplete', async () => {
      render(
        <ChatPage
          api={stubApi(
            [answer('Revenue is ')],
            new ChatStreamError(
              'The response stream closed early, so some details may be missing. Try asking again.',
            ),
          )}
          conversationMemory={false}
        />,
      );

      await ask();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/this answer is incomplete/i);
      // The partial text is still useful, provided it is labeled.
      expect(screen.getByText('Revenue is')).toBeInTheDocument();
    });

    it('does not report an incomplete answer when the stream completed', async () => {
      render(
        <ChatPage api={stubApi([answer('All good.')])} conversationMemory={false} />,
      );

      await ask();
      await screen.findByText('All good.');

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('reports a request failure separately from an incomplete stream', async () => {
    render(
      <ChatPage
        api={stubApi([], new ApiError(502, 'Upstream request failed.'))}
        conversationMemory={false}
      />,
    );

    await ask();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /upstream request failed/i,
    );
  });

  describe('conversation memory', () => {
    it('states that each question stands alone when memory is unavailable', () => {
      render(<ChatPage api={stubApi([])} conversationMemory={false} />);

      // Saying so up front rather than appearing to remember and then forgetting.
      expect(
        screen.getByText(/each question is answered on its own/i),
      ).toBeInTheDocument();
    });

    it('sends no conversationId when memory is unavailable', async () => {
      const chat = recordingChat();
      render(
        <ChatPage api={{ chat } as unknown as ApiClient} conversationMemory={false} />,
      );

      await ask();

      expect(chat.mock.calls[0]?.[0]).toEqual({
        message: 'What is the revenue forecast?',
      });
    });

    it('reuses one conversationId across turns when memory is available', async () => {
      const chat = recordingChat();
      render(<ChatPage api={{ chat } as unknown as ApiClient} conversationMemory />);

      await ask('first question');
      await screen.findByText('hi');
      await ask('second question');

      const first = chat.mock.calls[0]?.[0]?.conversationId;
      const second = chat.mock.calls[1]?.[0]?.conversationId;

      expect(first).toBeTruthy();
      expect(second).toBe(first);
    });
  });

  describe('accessibility', () => {
    it('labels the question field', () => {
      render(<ChatPage api={stubApi([])} conversationMemory={false} />);

      expect(
        screen.getByRole('textbox', { name: /ask a question/i }),
      ).toBeInTheDocument();
    });

    it('disables submission while an answer is streaming', async () => {
      render(
        <ChatPage api={stubApi([answer('working')])} conversationMemory={false} />,
      );

      await ask();

      // Prevents a second question racing the first, which would interleave answers.
      expect(await screen.findByText('working')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    });

    it('marks the answer region as busy while streaming', async () => {
      render(
        <ChatPage api={stubApi([answer('partial')])} conversationMemory={false} />,
      );

      await ask();

      // The text now sits inside rendered Markdown, so the live region is an ancestor of
      // the text node rather than the node itself.
      const region = (await screen.findByText('partial')).closest('[aria-live]');
      expect(region).toHaveAttribute('aria-live', 'polite');
    });
  });
});
