/**
 * Flattens a Markdown fragment into readable plain text.
 *
 * Used for result snippets, which are handled differently from generated answers on
 * purpose. An answer is authored prose with a structure worth rendering. A snippet is an
 * arbitrary *chunk* of a document — it can begin mid-sentence and it carries whatever
 * headings happened to fall inside it. Rendering that as Markdown would put an `<h1>` in
 * the middle of a result card, and showing it raw would leave `## Summary` markers in the
 * text, so it is flattened instead.
 *
 * Flattening rather than rendering also keeps snippets structurally inert: they are the
 * least trusted text in the application, and here they become a plain string.
 */

/**
 * Strips Markdown syntax, preserving the words and their order.
 *
 * Deliberately conservative. It removes formatting markers and collapses whitespace, and
 * does not attempt to interpret anything — no HTML is produced, and no text is reordered
 * or invented.
 */
export function markdownToPlainText(markdown: string): string {
  return (
    markdown
      // Fenced code blocks: keep the code, drop the fences.
      .replace(/```[\w-]*\n?/g, '')
      // Images before links, since the syntax nests: keep the alt text.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Heading markers, at the start of a line only.
      .replace(/^#{1,6}\s+/gm, '')
      // Blockquote and list markers.
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      // Emphasis. Bold before italic, so `**x**` does not leave a stray asterisk.
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      // Inline code.
      .replace(/`([^`]+)`/g, '$1')
      // Horizontal rules.
      .replace(/^\s*([-*_])\1{2,}\s*$/gm, '')
      // Table pipes, which otherwise read as noise.
      .replace(/\s*\|\s*/g, ' ')
      // Any remaining whitespace, including the newlines that separated all of the above.
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Flattens and truncates for display in a result card.
 *
 * Truncation is at a word boundary with an ellipsis, so a snippet never ends mid-word —
 * which reads as corrupted text rather than as an excerpt.
 */
export function snippetText(markdown: string, maxLength = 320): string {
  const plain = markdownToPlainText(markdown);
  if (plain.length <= maxLength) return plain;

  const clipped = plain.slice(0, maxLength);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}
