import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link } from 'react-router-dom';
import remarkGfm from 'remark-gfm';

import styles from './Markdown.module.css';

/**
 * Renders generated answer text, which arrives as Markdown.
 *
 * The model writes `## headings`, `**bold**` and `- lists`, and rendering that as
 * preformatted text would show the reader the syntax instead of the structure.
 *
 * ## Why this does not enable raw HTML
 *
 * The text being rendered is derived from retrieved documents, and retrieved document text
 * is **untrusted input**. Like any content passed to a model, it can influence generation,
 * and it can contain markup.
 *
 * `react-markdown` does not evaluate raw HTML unless `rehype-raw` is added, and it is
 * deliberately not added. Nothing here uses `dangerouslySetInnerHTML`. An `<img
 * onerror=…>` in a document therefore renders as text rather than executing — which is
 * the whole reason for using a real Markdown renderer rather than a regex and
 * `innerHTML`.
 *
 * Links are forced through `rel="noopener noreferrer"` and a new tab for the same reason:
 * the href comes from a document, not from us.
 *
 * ## Why `remark-gfm` is required rather than optional
 *
 * Base `react-markdown` implements CommonMark, and CommonMark has **no tables**. The
 * generator emits GitHub-flavoured tables routinely, because the corpus is full of
 * quarterly figures and a table is the right shape for them. Without this plugin those
 * arrive as a wall of pipe characters.
 * Strikethrough, task lists, and bare-URL autolinking come from the same plugin.
 *
 * Note this does **not** relax the raw-HTML position above. `remark-gfm` extends the
 * Markdown syntax the parser understands; it does not permit embedded HTML.
 */

export interface MarkdownProps {
  readonly children: string;
}

/** Whether a link's text is a bracketed number, and therefore a citation marker. */
function isMarkerText(children: unknown): boolean {
  return typeof children === 'string' && /^\[\d+\]$/.test(children);
}

/**
 * Styles a link as a citation marker when its text is a bracketed number.
 *
 * Content-based rather than class-based because the marker arrives as Markdown, and
 * Markdown link syntax carries no place to put a class. The alternative was raw HTML,
 * which this module refuses on principle. A document that happens to contain a link
 * labeled `[7]` gets marker styling, which is a cosmetic misfire and not worth more
 * machinery than this.
 */
function citationClass(children: unknown): string | undefined {
  return isMarkerText(children) ? styles.citation : undefined;
}

/**
 * Whether a paragraph contains nothing but citation markers.
 *
 * A citation covering a table or a code block cannot be marked inside it, so the marker
 * becomes a paragraph of its own underneath. Left unstyled that is a bare bracket run
 * floating under a table, which reads as debris rather than as attribution. Detecting the
 * case here lets CSS present it as a source line.
 */
function isCitationOnlyParagraph(children: unknown): boolean {
  const nodes = Array.isArray(children) ? children : [children];
  let markers = 0;

  for (const node of nodes) {
    if (typeof node === 'string') {
      if (node.trim() !== '') return false;
      continue;
    }
    if (
      typeof node === 'object' &&
      node !== null &&
      'props' in node &&
      isMarkerText((node as { props: { children?: unknown } }).props.children)
    ) {
      markers += 1;
      continue;
    }
    return false;
  }

  return markers > 0;
}

export function Markdown({ children }: MarkdownProps): ReactNode {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, href, children: linkText, ...props }) => {
            // An in-app destination has to be a router navigation, not an anchor. A plain
            // anchor to `/document?…` triggers a full page load, and because the ID token
            // is held in memory only, that reload lands on the viewer signed out and
            // bounces the reader to the identity provider. Citation markers are exactly
            // this case, so getting it wrong breaks them specifically.
            if (href !== undefined && href.startsWith('/')) {
              return (
                <Link to={href} className={citationClass(linkText)}>
                  {linkText}
                </Link>
              );
            }
            return (
              <a {...props} href={href} target="_blank" rel="noopener noreferrer">
                {linkText}
              </a>
            );
          },
          p: ({ node: _node, children: body, ...props }) => (
            <p
              {...props}
              {...(isCitationOnlyParagraph(body)
                ? { className: styles.citationLine }
                : {})}
            >
              {body}
            </p>
          ),
          // Answer text sits inside a panel that already has its own heading, so demote
          // the model's headings rather than emitting a second <h1> and breaking the
          // document outline for a screen reader.
          h1: ({ node: _node, ...props }) => <h4 {...props} />,
          h2: ({ node: _node, ...props }) => <h4 {...props} />,
          h3: ({ node: _node, ...props }) => <h5 {...props} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
