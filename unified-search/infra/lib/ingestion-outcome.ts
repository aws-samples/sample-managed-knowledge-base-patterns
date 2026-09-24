/**
 * Interprets the statistics an ingestion job reports.
 *
 * A pure function in `lib/` rather than logic inside the script, so it can be tested
 * without a deployed knowledge base. Ingestion statistics count new and modified
 * documents, so on an ACL-enabled data source zero documents indexed can mean either
 * unchanged content or documents with no matching ACL entry. The script reports both
 * possibilities rather than choosing one.
 */

export interface IngestionStatistics {
  readonly numberOfDocumentsScanned?: number;
  readonly numberOfNewDocumentsIndexed?: number;
  readonly numberOfModifiedDocumentsIndexed?: number;
  readonly numberOfDocumentsDeleted?: number;
  readonly numberOfDocumentsFailed?: number;
}

export type IngestionVerdict =
  /** Documents were indexed. Nothing more to say. */
  | { readonly kind: 'indexed'; readonly scanned: number; readonly indexed: number }
  /**
   * Finished cleanly but indexed nothing new.
   *
   * Not treated as a failure, because it is the correct outcome of re-ingesting
   * unchanged content — the counters are *new* and *modified* documents, not
   * documents present. A document with no matching ACL entry produces the same
   * statistics, so the operator is pointed at a check that tells the two apart.
   */
  | { readonly kind: 'nothing-new'; readonly scanned: number }
  /** Something is wrong and the caller should stop. */
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Classifies a finished ingestion job.
 *
 * @param status terminal job status, e.g. `COMPLETE`.
 */
export function classifyIngestion(
  status: string,
  statistics: IngestionStatistics | undefined,
): IngestionVerdict {
  const scanned = statistics?.numberOfDocumentsScanned ?? 0;
  const indexed =
    (statistics?.numberOfNewDocumentsIndexed ?? 0) +
    (statistics?.numberOfModifiedDocumentsIndexed ?? 0);
  const failed = statistics?.numberOfDocumentsFailed ?? 0;

  if (status !== 'COMPLETE') {
    return { kind: 'failed', reason: `Ingestion finished as ${status}.` };
  }

  if (failed > 0) {
    return {
      kind: 'failed',
      reason: `${String(failed)} document(s) failed to ingest.`,
    };
  }

  if (scanned === 0) {
    // Distinct from "scanned but not indexed": nothing was even seen, so the bucket
    // or the inclusion prefix is wrong rather than the ACLs.
    return {
      kind: 'failed',
      reason:
        'Nothing was scanned. The content bucket looks empty — run ' +
        '`npm run seed:sample` first.',
    };
  }

  if (indexed === 0) return { kind: 'nothing-new', scanned };

  return { kind: 'indexed', scanned, indexed };
}

/** Operator-facing explanation of the zero-indexed case. */
export const NOTHING_NEW_EXPLANATION = [
  'That is expected when re-ingesting unchanged content — the counters are new and',
  'modified documents, not documents present.',
  '',
  'It can also mean the ACL file does not match the content: on an ACL-enabled data',
  'source a document with no matching ACL entry is not ingested, so a missing or',
  'mismatched global ACL file produces a job that completes and indexes nothing. The',
  'ACL file is generated at seed time with the real bucket name to keep them aligned.',
  '',
  'Ingestion statistics report both cases the same way. Run `make test-acl` to tell',
  'them apart: it retrieves as known identities and fails if the corpus is not there.',
].join('\n');
