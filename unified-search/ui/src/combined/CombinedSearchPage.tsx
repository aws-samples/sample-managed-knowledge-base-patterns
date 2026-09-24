import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

import type { SearchHit } from '@domain';

import { AnswerPanel } from '../answer/AnswerPanel.tsx';
import { useChatStream } from '../answer/useChatStream.ts';
import { ApiError, type ApiClient } from '../api/client.ts';
import { CollapseToggle } from '../collapse/CollapseToggle.tsx';
import { ResultList } from '../results/ResultList.tsx';
import styles from './CombinedSearchPage.module.css';

/**
 * One query, two answers: a generated summary on top, the matching documents below.
 *
 * The familiar shape from web search, and the reason it is the default screen here. The
 * two halves come from genuinely different operations — `AgenticRetrieveStream`, which
 * decomposes the question and writes prose, and `Retrieve`, which ranks passages — and
 * showing them together is what makes the difference legible: the answer tells you what
 * your documents say, and the list tells you which documents said it.
 *
 * They are issued **in parallel**, not in sequence, so each half appears as soon as it is
 * ready rather than one waiting on the other.
 *
 * ## Both halves are filtered by the same identity
 *
 * Neither call carries a user identifier. The backend derives it from the verified token,
 * so the answer is grounded only in documents this user may read, and the list contains
 * only documents this user may read. Two people running the same query here see different
 * things, which is the property the sample exists to show.
 */

export interface CombinedSearchPageProps {
  readonly api: ApiClient;
}

/** Enough results to show ranking without turning the page into a scroll marathon. */
const RESULT_COUNT = 20;

/**
 * Starting points, chosen to show different behaviors.
 *
 * The example queries show a range of behaviors: a direct lookup, a cross-department
 * question that needs decomposition, and one whose answer differs per signed-in user.
 */
const EXAMPLES = [
  'What is the projected quarterly revenue forecast?',
  'What are the main risks and open items across teams this quarter?',
  'How do expenses and time off work?',
  "What are the platform team's Q3 priorities?",
] as const;

export function CombinedSearchPage({ api }: CombinedSearchPageProps): ReactNode {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(() => params.get('q') ?? '');
  const [hits, setHits] = useState<readonly SearchHit[] | undefined>();
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | undefined>();

  /**
   * Whether each half is expanded.
   *
   * Display only: both halves are always requested. Collapsing is for reading the page,
   * typically to look at the document list without the answer above it, and it has to work
   * on results already on screen rather than being a decision made before asking, so
   * collapsing and expanding again never requires a new search.
   *
   * Kept while this screen is mounted, so it survives repeated searches, and reset on
   * reload.
   */
  const [answerOpen, setAnswerOpen] = useState(true);
  const [documentsOpen, setDocumentsOpen] = useState(true);

  const chat = useChatStream(api);
  const inFlight = useRef<AbortController | undefined>(undefined);
  const inputId = useId();
  const statusId = useId();
  const answerRegionId = useId();
  const documentsRegionId = useId();

  // Abandon any request still running when this screen goes away, so a navigation closes
  // the stream rather than leaving it open with nothing to render into.
  useEffect(() => () => inFlight.current?.abort(), []);

  const run = useCallback(
    (query: string) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      setSearchError(undefined);
      setSearching(true);
      setHits(undefined);

      // Fired together. Neither waits for the other.
      const searching$ = api
        .search({ text: query, maxResults: RESULT_COUNT }, controller.signal)
        .then((page) => {
          if (controller.signal.aborted) return;
          setHits(page.hits);
        })
        .catch((caught: unknown) => {
          if (controller.signal.aborted) return;
          setSearchError(
            caught instanceof ApiError
              ? caught.message
              : 'Search failed. Please try again.',
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });

      // Single-turn on this screen: no conversationId, so nothing is written to memory.
      // Follow-up questions belong on the Chat screen, where continuity is the point.
      const answering$ = chat.ask({ message: query }, controller.signal);

      void Promise.allSettled([searching$, answering$]);
    },
    [api, chat],
  );

  const busy = searching || chat.streaming;
  const asked =
    hits !== undefined || chat.answer !== undefined || searchError !== undefined;

  const submit = (query: string) => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    setText(trimmed);
    // Recorded in the URL so leaving this screen and coming back restores the search rather
    // than an empty box. `replace`, so repeated searches do not fill the history with steps
    // the back button has to walk through one at a time.
    setParams(trimmed === '' ? {} : { q: trimmed }, { replace: true });
    run(trimmed);
  };

  // Runs the query in the URL on arrival, which covers a reload, a shared link, and
  // returning from another tab. Guarded on `asked` so it fires once rather than on every
  // render, and it deliberately re-runs the request instead of caching results: a stale
  // answer restored beside fresh permissions would be the wrong trade in an app whose whole
  // point is per-user filtering.
  // The box itself is seeded from the URL by the `useState` initializer above, so this only
  // has to issue the request.
  //
  // `set-state-in-effect` is disabled here rather than worked around. The rule exists to
  // catch state derived from props or other state being assigned in an effect, which causes
  // a second render to compute something that could have been computed during the first.
  // This is the other thing that looks the same to a linter: a side effect on arrival, whose
  // state is request state (`searching`, `hits`, `searchError`) rather than derived. The
  // available workarounds are worse than the exception, since deferring `run` to a microtask
  // would satisfy the rule while changing nothing about the render behavior it objects to.
  const queryParam = params.get('q') ?? '';
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (queryParam !== '' && !asked && !busy) run(queryParam);
  }, [queryParam, asked, busy, run]);

  /**
   * Whether the search found anything genuinely relevant, judged by whether the generated
   * answer cited anything.
   *
   * Semantic retrieval ranks documents by similarity and returns the nearest matches, so a
   * query about baseball against a corpus of business documents still returns the closest
   * business documents. Scores are for ordering results within one response, not an
   * absolute cutoff for relevance.
   *
   * The generated answer's citations give a complementary relevance signal: asked a real
   * question, the answer cites the documents it used; asked about something the corpus does
   * not cover, it cites nothing. This screen uses that signal, and the score stays what it
   * is — ordering within one result set.
   *
   * Read only once the answer is complete: a stream in flight has no citations yet, and
   * treating that as "nothing matched" would flash the warning on every search.
   */
  const nothingCloselyMatched =
    chat.answer !== undefined &&
    !chat.streaming &&
    chat.answer.incomplete === undefined &&
    chat.answer.citations.length === 0;

  return (
    <section className={styles.page} aria-labelledby={`${inputId}-heading`}>
      <h1 id={`${inputId}-heading`}>Search</h1>

      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          submit(text);
        }}
      >
        <label className={styles.label} htmlFor={inputId}>
          Search your documents
        </label>
        <div className={styles.controls}>
          <input
            id={inputId}
            className={styles.input}
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Ask a question, or search for a document"
            aria-describedby={statusId}
            autoComplete="off"
          />
          <button
            className={styles.submit}
            type="submit"
            disabled={text.trim().length === 0}
          >
            Search
          </button>
        </div>
      </form>

      {!asked && (
        <>
          <p className={styles.hint}>Try one of these:</p>
          <ul className={styles.examples}>
            {EXAMPLES.map((example) => (
              <li key={example}>
                <button
                  className={styles.example}
                  type="button"
                  onClick={() => submit(example)}
                >
                  {example}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <p id={statusId} className={styles.status} role="status" aria-live="polite">
        {statusMessage({
          busy,
          asked,
          hits,
          error: searchError,
          nothingCloselyMatched,
        })}
      </p>

      {chat.error !== undefined && (
        <p className={styles.error} role="alert">
          {chat.error}
        </p>
      )}

      {chat.answer !== undefined && (
        <section className={styles.section}>
          <div className={styles.sectionBar}>
            <h2 className={styles.sectionHeading}>Answer</h2>
            <CollapseToggle
              open={answerOpen}
              onToggle={() => setAnswerOpen(!answerOpen)}
              controls={answerRegionId}
              label="answer"
            />
          </div>

          {/* Kept mounted and hidden rather than unmounted, so collapsing mid-stream does
              not discard the answer arriving, and expanding shows it complete. */}
          <div id={answerRegionId} hidden={!answerOpen}>
            <AnswerPanel answer={chat.answer} streaming={chat.streaming} />
          </div>
        </section>
      )}

      {searchError !== undefined && (
        <p className={styles.error} role="alert">
          {searchError}
        </p>
      )}

      {hits !== undefined && hits.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionBar}>
            <h2 className={styles.sectionHeading}>
              {nothingCloselyMatched ? 'Closest documents' : 'Matching documents'}
            </h2>
            <CollapseToggle
              open={documentsOpen}
              onToggle={() => setDocumentsOpen(!documentsOpen)}
              controls={documentsRegionId}
              label="documents"
            />
          </div>

          {nothingCloselyMatched && (
            // Deliberately not a live region. The status paragraph above is the single
            // live region for this view and already announces this; a second one means a
            // screen reader reads both, in an order neither controls.
            <p className={styles.weak}>
              {/* Citations are the relevance signal used on this screen. See the note on
                  `nothingCloselyMatched` above. */}
              The answer didn't cite any of these documents. They're the closest matches
              by meaning and may be only loosely related. Try rephrasing or adding more
              detail.
            </p>
          )}

          <div id={documentsRegionId} hidden={!documentsOpen}>
            <ResultList
              hits={hits}
              caption={documentCaption(hits.length, nothingCloselyMatched)}
            />
          </div>
        </section>
      )}

      {hits !== undefined && hits.length === 0 && (
        <p className={styles.empty}>
          {/* Both readings are possible and are not distinguished, by design, so access
              isn't revealed. Both are stated because this is the first question a user of
              the sample will have. */}
          No documents matched. There may be no relevant content, or the relevant
          documents may not be shared with you.
        </p>
      )}
    </section>
  );
}

function statusMessage({
  busy,
  asked,
  hits,
  error,
  nothingCloselyMatched,
}: {
  busy: boolean;
  asked: boolean;
  hits: readonly SearchHit[] | undefined;
  error: string | undefined;
  nothingCloselyMatched: boolean;
}): string {
  if (busy) return 'Searching your documents and generating an answer…';
  if (!asked || error !== undefined) return '';
  if (hits === undefined) return '';
  if (hits.length === 0) return 'No documents matched.';

  const count = `${String(hits.length)} document${hits.length === 1 ? '' : 's'}`;
  return nothingCloselyMatched
    ? `No cited matches. Showing the ${count} closest by similarity.`
    : `${count} matched.`;
}

/**
 * The caption reflects the requested result count: it says "top N" when the list is full
 * rather than implying these are all the matches.
 *
 * When the answer cites nothing, it says "closest by similarity" rather than "most
 * relevant", since the list then shows the nearest content rather than confirmed matches.
 */
function documentCaption(count: number, nearestOnly: boolean): string {
  const documents = `document${count === 1 ? '' : 's'}`;

  if (nearestOnly) {
    return `${String(count)} closest ${documents} by similarity`;
  }
  return count >= RESULT_COUNT
    ? `Top ${String(count)} most relevant documents you have access to`
    : `${String(count)} ${documents} you have access to`;
}
