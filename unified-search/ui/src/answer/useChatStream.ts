import { useCallback, useRef, useState } from 'react';

import type { ChatTrace, Citation, SearchHit } from '@domain';

import {
  ApiError,
  ChatStreamError,
  type ApiClient,
  type ChatTurnRequest,
} from '../api/client.ts';

/**
 * Consumes a chat stream into renderable state.
 *
 * Shared between the combined search screen and the multi-turn chat screen so the
 * streaming rules exist once. Two of them are easy to get wrong and silent when wrong:
 *
 * - **Answer deltas concatenate in arrival order.** Citation spans are absolute offsets
 *   into that concatenation, so dropping or reordering a delta misaligns every highlight.
 * - **A stream that ends without completing has failed.** The server commits to `200`
 *   before it knows the answer will succeed, so a truncated stream is not an HTTP error.
 *   {@link Answer.incomplete} carries that, and the partial text is kept — it is useful,
 *   provided the caller says it is partial.
 */

export interface Answer {
  readonly question: string;
  readonly text: string;
  readonly traces: readonly ChatTrace[];
  readonly citations: readonly Citation[];
  readonly sources: readonly SearchHit[];
  /** Present when the stream failed. The text above is what arrived before it did. */
  readonly incomplete?: string;
}

const EMPTY: Omit<Answer, 'question'> = {
  text: '',
  traces: [],
  citations: [],
  sources: [],
};

export interface ChatStreamState {
  readonly answer?: Answer;
  readonly streaming: boolean;
  /** A request-level failure, as opposed to a stream that started and then broke. */
  readonly error?: string;
  readonly ask: (request: ChatTurnRequest, signal?: AbortSignal) => Promise<void>;
  readonly reset: () => void;
}

export function useChatStream(api: ApiClient): ChatStreamState {
  const [answer, setAnswer] = useState<Answer | undefined>();
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const generation = useRef(0);

  const reset = useCallback(() => {
    setAnswer(undefined);
    setError(undefined);
  }, []);

  const ask = useCallback(
    async (request: ChatTurnRequest, signal?: AbortSignal) => {
      // A monotonic token, so a slow earlier stream cannot write over a newer one. Without
      // it, typing a second question while the first is still streaming interleaves two
      // answers into one paragraph.
      generation.current += 1;
      const mine = generation.current;
      const current = () => generation.current === mine && signal?.aborted !== true;

      setError(undefined);
      setStreaming(true);
      setAnswer({ question: request.message, ...EMPTY });

      const update = (change: (draft: Answer) => Answer) => {
        setAnswer((previous) => (previous === undefined ? previous : change(previous)));
      };

      try {
        for await (const event of api.chat(request, signal)) {
          if (!current()) return;

          switch (event.kind) {
            case 'answer':
              update((draft) => ({ ...draft, text: draft.text + event.text }));
              break;
            case 'trace':
              update((draft) => ({ ...draft, traces: [...draft.traces, event.trace] }));
              break;
            case 'sources':
              update((draft) => ({
                ...draft,
                sources: [...draft.sources, ...event.hits],
              }));
              break;
            case 'citations':
              update((draft) => ({ ...draft, citations: event.citations }));
              break;
          }
        }
      } catch (caught) {
        if (!current()) return;

        if (caught instanceof ChatStreamError) {
          // Keep what arrived, and mark it incomplete.
          update((draft) => ({ ...draft, incomplete: caught.message }));
        } else {
          setError(
            caught instanceof ApiError
              ? caught.message
              : 'The answer could not be produced.',
          );
        }
      } finally {
        if (current()) setStreaming(false);
      }
    },
    [api],
  );

  return {
    ...(answer === undefined ? {} : { answer }),
    streaming,
    ...(error === undefined ? {} : { error }),
    ask,
    reset,
  };
}
