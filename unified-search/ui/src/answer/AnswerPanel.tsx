import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Markdown } from '../markdown/Markdown.tsx';
import { readableTitle } from '../results/readable-title.ts';
import { withInlineCitations } from './inline-citations.ts';
import type { Answer } from './useChatStream.ts';
import styles from './AnswerPanel.module.css';

/**
 * A generated answer with its reasoning steps and citations.
 *
 * Shared between the combined search screen and the multi-turn chat screen. The
 * incomplete-answer notice lives here rather than in each caller because it is the one
 * piece that must never be forgotten: the server commits to `200` before it knows the
 * answer will succeed, so a truncated stream arrives as content rather than an error, and
 * rendering it silently presents an incomplete answer as a complete one.
 */

export interface AnswerPanelProps {
  readonly answer: Answer;
  readonly streaming: boolean;
  /** Heading above the panel. Defaults to a label suited to a search results page. */
  readonly label?: string;
  /** Show the question the answer responds to. Useful in a transcript, noise otherwise. */
  readonly showQuestion?: boolean;
}

export function AnswerPanel({
  answer,
  streaming,
  label = 'Answer',
  showQuestion = false,
}: AnswerPanelProps): ReactNode {
  // Recomputed only when the answer changes. Mid-stream the citations array is empty, so
  // this is a pass-through until the final event lands and the markers appear at once.
  const cited = useMemo(
    () => withInlineCitations(answer.text, answer.citations),
    [answer.text, answer.citations],
  );

  return (
    <article className={styles.panel}>
      <h2 className={styles.heading}>
        {label}
        {streaming && <span aria-hidden="true">·</span>}
        {streaming && <span>generating</span>}
      </h2>

      {showQuestion && <p className={styles.question}>{answer.question}</p>}

      {answer.traces.length > 0 && (
        <details className={styles.traces}>
          {/* Collapsed, but present. On a multi-hop question the agent's decomposition is
              how a user sees why the answer was assembled the way it was, which is most of
              the value of agentic retrieval over plain search. */}
          <summary>How this answer was found ({answer.traces.length} steps)</summary>
          <ol>
            {answer.traces.map((trace, index) => (
              <li key={index}>
                <strong>{trace.label}</strong>
                {trace.detail !== undefined && <> — {trace.detail}</>}
              </li>
            ))}
          </ol>
        </details>
      )}

      <div className={styles.answer} aria-busy={streaming} aria-live="polite">
        {answer.text.length > 0 ? (
          <Markdown>{cited.text}</Markdown>
        ) : (
          <span className={styles.placeholder}>
            {streaming ? 'Reading your documents…' : 'No answer was generated.'}
          </span>
        )}
      </div>

      {answer.incomplete !== undefined && (
        <p className={styles.incomplete} role="alert">
          This answer is incomplete. {answer.incomplete}
        </p>
      )}

      {cited.sources.length > 0 && (
        <section className={styles.citations}>
          <h3 className={styles.citationsHeading}>Sources</h3>
          {/* Documents only. The claim text each citation covers is already on screen,
              marked in place, so repeating it here doubles the length of the answer and
              asks the reader to match two copies of the same sentence by eye. */}
          <ol className={styles.sources}>
            {cited.sources.map((source) => (
              <li key={source.number} className={styles.source}>
                {source.href === undefined ? (
                  <span>{readableTitle(source.title) ?? source.title}</span>
                ) : (
                  <Link to={source.href}>
                    {readableTitle(source.title) ?? source.title}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {answer.citations.length === 0 && answer.text.length > 0 && !streaming && (
        <p className={styles.ungrounded}>
          {/* An answer without citations isn't linked to a retrieved document, which is
              worth telling the reader. */}
          No sources were cited for this answer.
        </p>
      )}
    </article>
  );
}
