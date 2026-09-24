import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { ApiError, type ApiClient } from '../api/client.ts';
import { Markdown } from '../markdown/Markdown.tsx';
import { readableTitle } from '../results/readable-title.ts';
import styles from './DocumentView.module.css';

/**
 * Shows a document's full text.
 *
 * A search result is one chunk of one document, which is enough to decide whether a
 * document is worth reading and not enough to read it. The connector's own URL is not a
 * useful link target: for an S3 data source it points at a private bucket that correctly
 * denies direct access. This screen fetches the document through an access-checked
 * presigned URL instead.
 *
 * ## A route, not a modal
 *
 * A dialog would need a focus trap, `aria-modal`, Escape handling, and focus
 * restoration, all of which a route gets for free from the browser. The back button
 * works, the URL is shareable between people who both have access, and reload
 * re-fetches — which matters, because the underlying URL expires in minutes.
 *
 * ## Rendered as Markdown, and that choice is load-bearing
 *
 * Unlike a snippet, a whole document is complete: its headings open and close, its
 * lists start at one. So it renders rather than being flattened.
 *
 * The content is **untrusted** — it is the corpus, and like any retrieved text it can
 * contain markup. {@link Markdown} does not enable raw HTML, so a document containing `<img onerror=…>` displays that
 * text instead of executing it. This screen is where that property earns its keep: it
 * is the only place a document's full text reaches the DOM.
 */

export interface DocumentViewProps {
  readonly api: ApiClient;
}

/** What was loaded. Absent while loading — there is no `loading` variant to forget. */
type Outcome =
  | { readonly kind: 'text'; readonly body: string }
  | { readonly kind: 'binary'; readonly url: string; readonly mimeType: string }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * An outcome together with the document it describes.
 *
 * The pairing is what makes stale content unrenderable. This component stays mounted
 * across a navigation from one document to another, so an outcome held without its
 * document identifier would render the *previous* document under the new document's
 * title for as long as the new fetch takes. Comparing the identifier at render time
 * removes that window, and avoids a `setState` in the effect body, which would cause a
 * cascading render.
 */
interface Loaded {
  readonly documentId: string;
  readonly outcome: Outcome;
}

export function DocumentView({ api }: DocumentViewProps): ReactNode {
  const [params] = useSearchParams();
  const documentId = params.get('id') ?? '';
  const dataSourceId = params.get('source') ?? '';
  const title = params.get('title') ?? undefined;

  // Whether the link is usable is known at render time, so it is derived rather than
  // pushed into `state` from inside the effect. Calling `setState` synchronously in an
  // effect would be a cascading render to compute something already in hand.
  const addressable = documentId !== '' && dataSourceId !== '';

  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);

  // Anything held for a different document does not count.
  const outcome = loaded?.documentId === documentId ? loaded.outcome : undefined;

  useEffect(() => {
    if (!addressable) return undefined;

    const controller = new AbortController();
    const settle = (next: Outcome) => {
      setLoaded({ documentId, outcome: next });
    };

    void (async () => {
      try {
        const content = await api.documentContent(
          { documentId, dataSourceId },
          controller.signal,
        );

        // Only text is rendered. Anything else is offered as a link rather than
        // guessed at: a PDF piped through a Markdown renderer produces line noise.
        if (!isRenderableText(content.mimeType)) {
          settle({ kind: 'binary', url: content.url, mimeType: content.mimeType });
          return;
        }

        const body = await api.documentText(content.url, controller.signal);
        settle({ kind: 'text', body });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) {
          // 404 covers "does not exist" and "you may not read it", and the API does
          // not distinguish them on purpose — so neither does this message.
          settle({ kind: 'unavailable' });
          return;
        }
        settle({
          kind: 'failed',
          message:
            error instanceof Error
              ? error.message
              : 'The document could not be loaded.',
        });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [api, addressable, documentId, dataSourceId]);

  const heading = readableTitle(title) ?? 'Document';

  return (
    <article className={styles.document}>
      <p className={styles.back}>
        <Link to="/">← Back to search</Link>
      </p>

      <h2 className={styles.title}>{heading}</h2>
      {documentId !== '' && <p className={styles.identifier}>{documentId}</p>}

      {!addressable && (
        <p className={styles.error} role="alert">
          That link is missing a document reference.
        </p>
      )}

      {addressable && outcome === undefined && (
        <p role="status">Loading the document…</p>
      )}

      {outcome?.kind === 'unavailable' && (
        <p className={styles.notice} role="status">
          That document is not available. It may not exist, or you may not have
          permission to read it.
        </p>
      )}

      {outcome?.kind === 'failed' && (
        <p className={styles.error} role="alert">
          {outcome.message}
        </p>
      )}

      {outcome?.kind === 'binary' && (
        <p className={styles.notice}>
          This document is a {outcome.mimeType} file, which cannot be shown here.{' '}
          <a href={outcome.url} target="_blank" rel="noopener noreferrer">
            Open the original
          </a>
          . That link expires in a few minutes; reload this page for a fresh one.
        </p>
      )}

      {outcome?.kind === 'text' && (
        <div className={styles.body}>
          <Markdown>{outcome.body}</Markdown>
        </div>
      )}
    </article>
  );
}

/**
 * Whether this content can be rendered as text.
 *
 * Allowlisted rather than "anything that is not a known binary type": an unrecognised
 * type is offered as a download, which is recoverable, whereas rendering arbitrary
 * bytes as Markdown is not.
 */
function isRenderableText(mimeType: string): boolean {
  const type = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/xml'
  );
}
