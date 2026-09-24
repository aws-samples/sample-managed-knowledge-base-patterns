import { useCallback, useId, useRef, useState, type ReactNode } from 'react';

import { AnswerPanel } from '../answer/AnswerPanel.tsx';
import { type Answer } from '../answer/useChatStream.ts';
import { ApiError, ChatStreamError, type ApiClient } from '../api/client.ts';
import styles from './ChatPage.module.css';

/**
 * Multi-turn conversation.
 *
 * Distinct from the combined search screen, which answers one question at a time and
 * writes nothing to memory. This screen is where continuity is the point, so it keeps a
 * transcript and a stable conversation id.
 *
 * ## Conversation memory is optional, and the UI says which
 *
 * Without a configured memory resource every question is answered independently. The
 * provider reports that through `capabilities.conversationMemory`, and this screen states
 * it rather than appearing to remember and then not remembering.
 */

export interface ChatPageProps {
  readonly api: ApiClient;
  /** From `GET /knowledgebase/capabilities`. */
  readonly conversationMemory: boolean;
}

export function ChatPage({ api, conversationMemory }: ChatPageProps): ReactNode {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<readonly Answer[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const inputId = useId();

  // Created lazily on first use rather than during render: generating it in the render
  // body is an impure call, and a fresh value per tab avoids two tabs writing into one
  // conversation. Scoped within the signed-in user regardless — the server derives the
  // memory actor from the verified token, so this cannot reach another user's history.
  const conversationId = useRef<string | undefined>(undefined);
  const inFlight = useRef<AbortController | undefined>(undefined);

  const ask = useCallback(
    async (text: string) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      const ensureConversationId = (): string => {
        conversationId.current ??= crypto.randomUUID();
        return conversationId.current;
      };

      setError(undefined);
      setStreaming(true);
      setQuestion('');
      setTurns((previous) => [
        ...previous,
        { question: text, text: '', traces: [], citations: [], sources: [] },
      ]);

      /** Replaces the last turn, so React sees a new object and re-renders. */
      const update = (change: (draft: Answer) => Answer) => {
        setTurns((previous) => {
          const last = previous.at(-1);
          if (last === undefined) return previous;
          return [...previous.slice(0, -1), change(last)];
        });
      };

      try {
        for await (const event of api.chat(
          {
            message: text,
            ...(conversationMemory ? { conversationId: ensureConversationId() } : {}),
          },
          controller.signal,
        )) {
          switch (event.kind) {
            case 'answer':
              // Concatenate in arrival order. Citation spans index into this string, so
              // reordering or dropping a delta misaligns every highlight.
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
        if (controller.signal.aborted) return;

        if (caught instanceof ChatStreamError) {
          // Keep the partial answer, and mark it as partial.
          update((draft) => ({ ...draft, incomplete: caught.message }));
        } else {
          setError(
            caught instanceof ApiError
              ? caught.message
              : 'The answer could not be produced.',
          );
        }
      } finally {
        setStreaming(false);
      }
    },
    [api, conversationMemory],
  );

  return (
    <section className={styles.page} aria-labelledby={`${inputId}-heading`}>
      <h1 id={`${inputId}-heading`}>Chat</h1>

      <p className={styles.memory}>
        {conversationMemory
          ? 'Follow-up questions continue this conversation.'
          : 'Conversation memory is not configured, so each question is answered on its own.'}
      </p>

      <ol className={styles.turns}>
        {turns.map((turn, index) => (
          <li key={index}>
            <AnswerPanel
              answer={turn}
              streaming={streaming && index === turns.length - 1}
              label={`Turn ${String(index + 1)}`}
              showQuestion
            />
          </li>
        ))}
      </ol>

      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (question.trim().length > 0 && !streaming) void ask(question.trim());
        }}
      >
        <label className={styles.label} htmlFor={inputId}>
          Ask a question about your documents
        </label>
        <div className={styles.controls}>
          <input
            id={inputId}
            className={styles.input}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What is the Q3 revenue forecast?"
            autoComplete="off"
          />
          <button
            className={styles.submit}
            type="submit"
            disabled={streaming || question.trim().length === 0}
          >
            {streaming ? 'Answering…' : 'Ask'}
          </button>
        </div>
      </form>
    </section>
  );
}
