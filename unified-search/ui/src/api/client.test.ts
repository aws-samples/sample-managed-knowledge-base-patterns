import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatEvent } from '@domain';

import { ApiClient, ApiError, ChatStreamError } from './client.ts';

/**
 * The chat stream carries the load here. Its two failure modes — frames split across
 * network chunks, and a stream that ends without completing — are both silent if
 * mishandled: the first drops answer text, the second presents a truncated answer as a
 * finished one.
 */

/** Builds a `Response` whose body streams the given chunks, split exactly as given. */
function streamingResponse(chunks: readonly string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function frame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const ANSWER = (text: string): ChatEvent => ({ kind: 'answer', text });

function client(fetchImpl: typeof fetch): ApiClient {
  vi.stubGlobal('fetch', fetchImpl);
  return new ApiClient({ baseUrl: 'http://api.test', getToken: () => 'token-123' });
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const collected: ChatEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiClient', () => {
  describe('authentication', () => {
    it('sends the bearer token', async () => {
      let seen: HeadersInit | undefined;
      const api = client(((_url: string, init?: RequestInit) => {
        seen = init?.headers;
        return Promise.resolve(
          new Response(JSON.stringify({ hits: [] }), { status: 200 }),
        );
      }) as unknown as typeof fetch);

      await api.search({ text: 'revenue' });

      expect((seen as Record<string, string>).Authorization).toBe('Bearer token-123');
    });

    it('omits the header when signed out rather than sending an empty one', async () => {
      let seen: Record<string, string> = {};
      vi.stubGlobal('fetch', ((_url: string, init?: RequestInit) => {
        seen = (init?.headers ?? {}) as Record<string, string>;
        return Promise.resolve(
          new Response(JSON.stringify({ hits: [] }), { status: 200 }),
        );
      }) as unknown as typeof fetch);

      const api = new ApiClient({
        baseUrl: 'http://api.test',
        getToken: () => undefined,
      });
      await api.search({ text: 'revenue' });

      // `Bearer undefined` would be sent as a real header and rejected with a
      // less specific error; omitting it produces a clean 401.
      expect(seen).not.toHaveProperty('Authorization');
    });
  });

  describe('search', () => {
    it('returns the page', async () => {
      const page = {
        hits: [{ id: 'doc-1', snippet: 'text', sourceType: 's3', metadata: {} }],
      };
      const api = client((() =>
        Promise.resolve(
          new Response(JSON.stringify(page), { status: 200 }),
        )) as typeof fetch);

      await expect(api.search({ text: 'revenue' })).resolves.toEqual(page);
    });

    it('raises ApiError with the server message', async () => {
      const api = client((() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ message: 'The query could not be processed.' }),
            {
              status: 400,
            },
          ),
        )) as typeof fetch);

      await expect(api.search({ text: '' })).rejects.toThrow(ApiError);
      await expect(api.search({ text: '' })).rejects.toThrow(/could not be processed/);
    });

    it('falls back to the status when the error body is not JSON', async () => {
      const api = client((() =>
        Promise.resolve(
          new Response('<html>502</html>', { status: 502 }),
        )) as typeof fetch);

      // Infrastructure errors never reach the application, so the body is whatever a
      // proxy produced.
      await expect(api.search({ text: 'x' })).rejects.toThrow(/status 502/);
    });
  });

  describe('chat', () => {
    it('yields events and completes on the done frame', async () => {
      const api = client((() =>
        Promise.resolve(
          streamingResponse([
            frame('message', { kind: 'trace', trace: { label: 'Retrieval' } }),
            frame('message', ANSWER('Revenue is ')),
            frame('message', ANSWER('$4.2 million.')),
            frame('done', {}),
          ]),
        )) as typeof fetch);

      const events = await collect(api.chat({ message: 'revenue?' }));

      expect(events.map((event) => event.kind)).toEqual(['trace', 'answer', 'answer']);
    });

    /**
     * A chunk boundary has nothing to do with a frame boundary. This splits the stream
     * at every single character, which is the strongest form of the property: no
     * arrangement of chunks may change the events produced.
     */
    it('reassembles frames split at every possible byte boundary', async () => {
      const whole = [
        frame('message', ANSWER('Revenue is ')),
        frame('message', ANSWER('$4.2 million.')),
        frame('done', {}),
      ].join('');

      const api = client((() =>
        Promise.resolve(streamingResponse([...whole]))) as typeof fetch);

      const events = await collect(api.chat({ message: 'revenue?' }));

      const answer = events
        .filter(
          (event): event is Extract<ChatEvent, { kind: 'answer' }> =>
            event.kind === 'answer',
        )
        .map((event) => event.text)
        .join('');

      // Citation spans index into this string, so losing or duplicating a character
      // misaligns every highlight.
      expect(answer).toBe('Revenue is $4.2 million.');
    });

    it('handles a frame split mid-JSON across two chunks', async () => {
      const whole = frame('message', ANSWER('half and half')) + frame('done', {});
      const cut = Math.floor(whole.length / 2);
      const api = client((() =>
        Promise.resolve(
          streamingResponse([whole.slice(0, cut), whole.slice(cut)]),
        )) as typeof fetch);

      const events = await collect(api.chat({ message: 'q' }));

      expect(events).toEqual([ANSWER('half and half')]);
    });

    it('ignores keep-alive comment frames', async () => {
      const api = client((() =>
        Promise.resolve(
          streamingResponse([
            ': ping\n\n',
            frame('message', ANSWER('hi')),
            frame('done', {}),
          ]),
        )) as typeof fetch);

      await expect(collect(api.chat({ message: 'q' }))).resolves.toEqual([
        ANSWER('hi'),
      ]);
    });

    it('tolerates CRLF line endings', async () => {
      const api = client((() =>
        Promise.resolve(
          streamingResponse([
            `event: message\r\ndata: ${JSON.stringify(ANSWER('crlf'))}\r\n\r\n`,
            'event: done\r\ndata: {}\r\n\r\n',
          ]),
        )) as typeof fetch);

      await expect(collect(api.chat({ message: 'q' }))).resolves.toEqual([
        ANSWER('crlf'),
      ]);
    });

    /**
     * The failure this design exists to make visible. The server commits to 200 before
     * it knows the answer will succeed, so a truncated stream is not an HTTP error.
     */
    describe('an incomplete stream', () => {
      it('raises ChatStreamError when the stream ends without a done frame', async () => {
        const api = client((() =>
          Promise.resolve(
            streamingResponse([frame('message', ANSWER('partial'))]),
          )) as typeof fetch);

        await expect(collect(api.chat({ message: 'q' }))).rejects.toThrow(
          ChatStreamError,
        );
      });

      it('raises ChatStreamError carrying the server message on an error frame', async () => {
        const api = client((() =>
          Promise.resolve(
            streamingResponse([
              frame('message', ANSWER('partial')),
              frame('error', { message: 'The answer could not be completed.' }),
            ]),
          )) as typeof fetch);

        await expect(collect(api.chat({ message: 'q' }))).rejects.toThrow(
          /could not be completed/,
        );
      });

      it('still yields the events that arrived before the failure', async () => {
        const api = client((() =>
          Promise.resolve(
            streamingResponse([
              frame('message', ANSWER('partial answer')),
              frame('error', { message: 'boom' }),
            ]),
          )) as typeof fetch);

        const received: ChatEvent[] = [];
        await expect(
          (async () => {
            for await (const event of api.chat({ message: 'q' })) received.push(event);
          })(),
        ).rejects.toThrow(ChatStreamError);

        // A partial answer is worth showing, provided the caller is told it is partial.
        expect(received).toEqual([ANSWER('partial answer')]);
      });
    });

    it('raises ApiError without reading a stream when the request itself fails', async () => {
      const api = client((() =>
        Promise.resolve(
          new Response(JSON.stringify({ message: 'Invalid credentials' }), {
            status: 401,
          }),
        )) as typeof fetch);

      await expect(collect(api.chat({ message: 'q' }))).rejects.toThrow(ApiError);
    });
  });
});
