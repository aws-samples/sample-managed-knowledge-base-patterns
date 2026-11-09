/** Text output helpers. stdout carries results only; progress lines and errors go to stderr. */

export const TRACE_KEYS = ['step', 'status', 'message', 'appliedInstruction'] as const;

/** Rows (header first) as lines: columns two spaces apart, each left-aligned to its longest cell. */
export function table(rows: readonly (readonly string[])[], indent = '  '): string[] {
  const first = rows[0];
  if (first === undefined) return [];
  const widths = first.map((_, i) =>
    Math.max(...rows.map((row) => (row[i] ?? '').length)),
  );
  return rows.map((row) =>
    (indent + row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ')).trimEnd(),
  );
}

/**
 * A value as Python's `json.dumps` writes it with the default separators (`", "` and `": "`),
 * so both programs print the same bytes. `ensureAscii` escapes non-ASCII as Python's default does.
 */
export function pyJsonDumps(value: unknown, ensureAscii = true): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') {
    const text = JSON.stringify(value);
    if (!ensureAscii) return text;
    return text.replace(
      /[\u0080-\uffff]/g,
      (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => pyJsonDumps(item, ensureAscii)).join(', ')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  const parts = entries.map(
    ([k, v]) => `${pyJsonDumps(k, ensureAscii)}: ${pyJsonDumps(v, ensureAscii)}`,
  );
  return `{${parts.join(', ')}}`;
}

/** One trace event as a single JSON line, keys in a fixed order, non-ASCII kept readable. */
export function dumpsCompact(attributes: Readonly<Record<string, unknown>>): string {
  const picked: Record<string, unknown> = {};
  for (const key of TRACE_KEYS) {
    if (attributes[key] !== undefined) picked[key] = attributes[key];
  }
  return pyJsonDumps(picked, false);
}

/** UTC ISO 8601 with second precision and Z, for example 2026-10-01T12:00:00Z. */
export function utc(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Versions as `1, 2`, `none` for an empty list, `-` when unknown. */
export function versionsText(versions: readonly string[] | null | undefined): string {
  if (versions === null || versions === undefined) return '-';
  return versions.length ? versions.join(', ') : 'none';
}

export function plural(count: number, word: string): string {
  return count === 1 ? `${count} ${word}` : `${count} ${word}s`;
}

/** A value as Python's str() prints it, for fields that may be missing from a service response. */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

/** Write result text to stdout (text already ends with a newline). */
export function out(text: string): void {
  process.stdout.write(text);
}

/** Write one progress line to stderr. */
export function progress(message: string): void {
  process.stderr.write(`${message}\n`);
}
