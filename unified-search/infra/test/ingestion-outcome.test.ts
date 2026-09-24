import { describe, expect, it } from 'vitest';

import { classifyIngestion } from '../lib/ingestion-outcome';

/**
 * Ingestion statistics count new and modified documents, so on an ACL-enabled data
 * source zero indexed can mean unchanged content or no matching ACL entry. This
 * classification separates the cases the statistics can decide from the one they
 * cannot.
 */
describe('classifyIngestion', () => {
  it('reports success when documents were indexed', () => {
    expect(
      classifyIngestion('COMPLETE', {
        numberOfDocumentsScanned: 3,
        numberOfNewDocumentsIndexed: 3,
      }),
    ).toEqual({ kind: 'indexed', scanned: 3, indexed: 3 });
  });

  it('counts modified documents as indexed', () => {
    // A re-ingest after one document changed: `3 scanned / 1 indexed`, where the one
    // is a modified document rather than a new one.
    expect(
      classifyIngestion('COMPLETE', {
        numberOfDocumentsScanned: 3,
        numberOfNewDocumentsIndexed: 0,
        numberOfModifiedDocumentsIndexed: 1,
      }),
    ).toEqual({ kind: 'indexed', scanned: 3, indexed: 1 });
  });

  /**
   * Re-ingesting unchanged content indexes nothing new, which is the ordinary case of
   * running `make sample` twice, so it must not be reported as a failure.
   */
  it('does not fail when nothing was newly indexed', () => {
    expect(
      classifyIngestion('COMPLETE', {
        numberOfDocumentsScanned: 3,
        numberOfNewDocumentsIndexed: 0,
        numberOfModifiedDocumentsIndexed: 0,
      }),
    ).toEqual({ kind: 'nothing-new', scanned: 3 });
  });

  it('fails when nothing was scanned', () => {
    // Distinct from scanned-but-not-indexed: nothing was even seen, so the bucket or
    // the inclusion prefix is wrong rather than the ACLs.
    const verdict = classifyIngestion('COMPLETE', { numberOfDocumentsScanned: 0 });

    expect(verdict.kind).toBe('failed');
    expect(verdict).toMatchObject({ reason: expect.stringContaining('seed:sample') });
  });

  it('fails when any document failed to ingest', () => {
    const verdict = classifyIngestion('COMPLETE', {
      numberOfDocumentsScanned: 3,
      numberOfNewDocumentsIndexed: 2,
      numberOfDocumentsFailed: 1,
    });

    // A partial success is still a corpus with a hole in it, and a user cannot tell
    // a missing document from a denied one.
    expect(verdict.kind).toBe('failed');
    expect(verdict).toMatchObject({
      reason: expect.stringContaining('1 document(s) failed'),
    });
  });

  it('fails on any non-COMPLETE terminal status', () => {
    for (const status of ['FAILED', 'STOPPED']) {
      const verdict = classifyIngestion(status, {
        numberOfDocumentsScanned: 3,
        numberOfNewDocumentsIndexed: 3,
      });

      expect(verdict.kind, status).toBe('failed');
      expect(verdict, status).toMatchObject({
        reason: expect.stringContaining(status),
      });
    }
  });

  it('treats absent statistics as nothing scanned rather than as success', () => {
    // A job that reports no statistics has not demonstrated that anything worked.
    expect(classifyIngestion('COMPLETE', undefined).kind).toBe('failed');
  });
});
