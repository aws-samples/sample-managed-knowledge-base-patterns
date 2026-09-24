/**
 * Makes a file name readable.
 *
 * `_document_title` contains the source file name, such as
 * `platform-roadmap-q3-2026-4.md`. For display, the extension and numeric suffix are
 * dropped, hyphens become spaces, and words are capitalized.
 *
 * Deliberately presentation-only and deliberately lossy: this invents nothing that is not
 * already in the file name, and the full identifier stays reachable through the link. If a
 * connector ever supplies a real title this becomes a no-op for anything already
 * capitalised and spaced.
 */
export function readableTitle(title: string | undefined): string | undefined {
  if (title === undefined || title.trim().length === 0) return undefined;

  const withoutExtension = title.replace(/\.(md|txt|pdf|docx?|html?)$/i, '');
  // A trailing numeric suffix such as `-4` is treated as a uniqueness suffix, not part of
  // the name.
  const withoutIndex = withoutExtension.replace(/-\d+$/, '');

  if (!withoutIndex.includes('-') && !withoutIndex.includes('_'))
    return withoutExtension;

  return withoutIndex
    .split(/[-_]+/)
    .filter((word) => word.length > 0)
    .map((word) =>
      // Quarters and years read better left alone than title-cased into "Q3" → "Q3".
      /^q[1-4]$/i.test(word)
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}
