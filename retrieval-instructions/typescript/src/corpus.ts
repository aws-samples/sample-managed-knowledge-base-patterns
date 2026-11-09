/**
 * Name, scope, and entitlement for each document a trace or result returns.
 *
 * Every document resolves to an S3 key under docs/, which is looked up by `path` in
 * corpus/manifest.json. A document that can't be identified prints as `unknown` and counts as
 * outside the entitlement (fail closed).
 */

import * as fs from 'node:fs';
import { entitled } from './filters';
import { MANIFEST_FILE } from './paths';

export const EXPANSION_RE =
  /^Starting full document expansion for document: (s3:\/\/[^/\s]+\/(\S+))$/;
export const UNKNOWN = 'unknown';

export interface Document {
  key: string;
  scope: string;
  region: string;
  audienceTeam: string;
}

export interface Classified {
  document: string; // file name, or "unknown"
  scope: string; // manifest scope, or "unknown"
  entitled: string; // "yes", "no", or "unknown"
}

/** Whether a classified document counts as outside the entitlement. */
export function outside(c: Classified): boolean {
  return c.entitled !== 'yes';
}

let manifestCache: Map<string, Document> | undefined;

export function manifest(): Map<string, Document> {
  if (manifestCache === undefined) {
    const docs = (
      JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')) as {
        docs: { path: string; scope: string; region: string; audience_team: string }[];
      }
    ).docs;
    manifestCache = new Map(
      docs.map((d) => [
        d.path,
        {
          key: d.path,
          scope: d.scope,
          region: d.region,
          audienceTeam: d.audience_team,
        },
      ]),
    );
  }
  return manifestCache;
}

/** Percent-decode a URL path as Python's urllib.parse.unquote does (UTF-8, bad bytes replaced). */
function unquote(text: string): string {
  if (!text.includes('%')) return text;
  const bytes: number[] = [];
  for (let i = 0; i < text.length;) {
    const hex = text.slice(i + 1, i + 3);
    if (text[i] === '%' && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 3;
    } else {
      const ch = String.fromCodePoint(text.codePointAt(i) ?? 0);
      bytes.push(...Buffer.from(ch, 'utf8'));
      i += ch.length;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The path part of a URL, as Python's urllib.parse.urlsplit splits it. Never throws. */
function urlPath(uri: string): string {
  const match = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?(?:\/\/[^/?#]*)?([^?#]*)/.exec(uri);
  return match?.[1] ?? '';
}

/** The S3 key from a `_source_uri`: the percent-decoded path from its first `docs/` segment. */
export function keyFromSourceUri(uri: unknown): string | null {
  if (typeof uri !== 'string') return null;
  const parts = unquote(urlPath(uri)).split('/');
  const start = parts.indexOf('docs');
  if (start === -1) return null;
  return parts.slice(start).join('/');
}

/** The S3 key named by a FullDocumentExpansion IN_PROGRESS message, or null when it doesn't match. */
export function keyFromExpansionMessage(message: unknown): string | null {
  const match = typeof message === 'string' ? EXPANSION_RE.exec(message) : null;
  return match?.[2] ?? null;
}

export function classify(
  key: string | null,
  tenant: string,
  region: string | null = null,
): Classified {
  const doc = key ? manifest().get(key) : undefined;
  if (doc === undefined)
    return { document: UNKNOWN, scope: UNKNOWN, entitled: UNKNOWN };
  const ok = entitled(
    tenant,
    { region: doc.region, audience_team: doc.audienceTeam },
    region,
  );
  return {
    document: doc.key.split('/').at(-1) ?? doc.key,
    scope: doc.scope,
    entitled: ok ? 'yes' : 'no',
  };
}
