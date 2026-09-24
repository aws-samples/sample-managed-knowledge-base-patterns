import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { SearchHit } from '@domain';

import { snippetText } from '../markdown/plain-text.ts';
import { readableTitle } from './readable-title.ts';
import styles from './ResultList.module.css';

/**
 * The list of retrieved documents.
 *
 * ## Why no relevance score is displayed
 *
 * Scores express relative ordering within one response and aren't calibrated for
 * comparison across queries, so a value like `0.77` is not a percentage and is not
 * comparable with a score from a different search.
 *
 * The list is already sorted by score, so showing the number would add no information the
 * position doesn't already give, and it could be misread as a percentage.
 *
 * The relevance cue the UI does give comes from citations instead: if the generated answer
 * cites no source, the list is labeled as the closest matches by similarity rather than as
 * matching documents.
 */

export interface ResultListProps {
  readonly hits: readonly SearchHit[];
  /** Rendered above the list, e.g. "78 documents". */
  readonly caption?: string;
}

export function ResultList({ hits, caption }: ResultListProps): ReactNode {
  if (hits.length === 0) return null;

  return (
    <>
      {caption !== undefined && <p className={styles.caption}>{caption}</p>}
      <ol className={styles.results}>
        {hits.map((hit, index) => (
          <li key={`${hit.id}-${String(index)}`} className={styles.result}>
            <Result hit={hit} />
          </li>
        ))}
      </ol>
    </>
  );
}

function Result({ hit }: { readonly hit: SearchHit }): ReactNode {
  // Title comes from document metadata and may be absent, so fall back to the URI or ID
  // rather than rendering an empty heading.
  const heading = readableTitle(hit.title) ?? hit.uri ?? hit.id;
  const viewer = documentPath(hit);

  return (
    <article>
      <h3 className={styles.resultTitle}>
        {viewer === undefined ? (
          // Without both identifiers there is nothing to link to. `hit.uri` is not used
          // as a fallback: for an S3 data source the connector URL points at a private
          // bucket that correctly denies direct access, while the in-app viewer fetches
          // through an access-checked presigned URL.
          heading
        ) : (
          <Link to={viewer}>{heading}</Link>
        )}
      </h3>
      {/* Flattened, not rendered as Markdown: a snippet is an arbitrary chunk that can
          begin mid-sentence and carry whatever headings fell inside it, so rendering it
          would drop an <h1> into the middle of a result card. */}
      <p className={styles.snippet}>{snippetText(hit.snippet)}</p>
      <p className={styles.meta}>
        <span className={styles.sourceType}>{hit.sourceType}</span>
        {departmentOf(hit) !== undefined && (
          // Useful in a demo: it makes the access control boundary visible at a glance,
          // since permissions in the sample corpus are granted by folder.
          <span className={styles.department}>{departmentOf(hit)}</span>
        )}
        {/* The score is deliberately not shown. See the note above `ResultListProps`. */}
      </p>
    </article>
  );
}

/**
 * In-app viewer path for a hit, or nothing if it cannot be addressed.
 *
 * Both identifiers are required because the underlying operation requires both, so a
 * hit missing either would produce a link that can only fail. The title rides along to
 * spare the viewer a second lookup just to render a heading — it is presentation only,
 * and the viewer does not trust it for anything else.
 */
function documentPath(hit: SearchHit): string | undefined {
  if (hit.id === '' || hit.dataSourceId === undefined) return undefined;

  const params = new URLSearchParams({ id: hit.id, source: hit.dataSourceId });
  if (hit.title !== undefined) params.set('title', hit.title);
  return `/document?${params.toString()}`;
}

/**
 * Best-effort folder name from the document's location.
 *
 * Presentation only, and absent when the shape is unfamiliar — a connector this build has
 * never seen must not break the row.
 */
function departmentOf(hit: SearchHit): string | undefined {
  const source = hit.uri ?? hit.id;
  const match = /\/content\/([^/]+)\//.exec(source);
  return match?.[1];
}
