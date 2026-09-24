import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { resolveKnowledgeBaseSelection } from '../lib/knowledge-base-selection';

function appWith(context: Record<string, unknown>): cdk.App {
  return new cdk.App({ context });
}

describe('resolveKnowledgeBaseSelection', () => {
  describe('byo', () => {
    it('accepts a well-formed knowledge base ID', () => {
      const selection = resolveKnowledgeBaseSelection(
        appWith({ kbMode: 'byo', knowledgeBaseId: 'ABCDE12345' }),
      );

      expect(selection).toEqual({ mode: 'byo', knowledgeBaseId: 'ABCDE12345' });
    });

    it('trims surrounding whitespace', () => {
      const selection = resolveKnowledgeBaseSelection(
        appWith({ kbMode: ' BYO ', knowledgeBaseId: ' ABCDE12345 ' }),
      );

      expect(selection).toEqual({ mode: 'byo', knowledgeBaseId: 'ABCDE12345' });
    });

    it('requires a knowledge base ID', () => {
      expect(() => resolveKnowledgeBaseSelection(appWith({ kbMode: 'byo' }))).toThrow(
        /requires context value 'knowledgeBaseId'/,
      );
    });

    // A mistyped ID would otherwise deploy cleanly and fail every query at
    // runtime, which is a much worse place to discover it.
    it.each([
      ['too short', 'ABC123'],
      ['too long', 'ABCDE123456'],
      ['contains a hyphen', 'ABCDE-1234'],
      ['contains a slash', 'ABCDE/1234'],
      [
        'an ARN rather than an ID',
        'arn:aws:bedrock:us-east-1:1:knowledge-base/ABCDE12345',
      ],
    ])('rejects an ID that is %s', (_label, knowledgeBaseId) => {
      expect(() =>
        resolveKnowledgeBaseSelection(appWith({ kbMode: 'byo', knowledgeBaseId })),
      ).toThrow(/10 alphanumeric characters/);
    });
  });

  describe('sample', () => {
    it('needs no knowledge base ID', () => {
      expect(resolveKnowledgeBaseSelection(appWith({ kbMode: 'sample' }))).toEqual({
        mode: 'sample',
      });
    });

    // Ambiguous intent: either the mode is a typo for byo, or the operator expects
    // their existing knowledge base to be adopted, which this app will not do.
    it('rejects being given a knowledge base ID as well', () => {
      expect(() =>
        resolveKnowledgeBaseSelection(
          appWith({ kbMode: 'sample', knowledgeBaseId: 'ABCDE12345' }),
        ),
      ).toThrow(/must not be set/);
    });
  });

  /**
   * The mode must never be inferred.
   *
   * If absence of an ID implied "create one", a typo in a context key would
   * silently provision a knowledge base and begin incurring ingestion and storage
   * charges. Failing closed on an unspecified mode is the whole point.
   */
  describe('the mode is required, never inferred', () => {
    it('rejects an empty context', () => {
      expect(() => resolveKnowledgeBaseSelection(appWith({}))).toThrow(
        /Missing required context value 'kbMode'/,
      );
    });

    it('does not infer sample mode from a missing ID', () => {
      expect(() => resolveKnowledgeBaseSelection(appWith({}))).toThrow();
    });

    it('does not infer byo mode from a supplied ID', () => {
      expect(() =>
        resolveKnowledgeBaseSelection(appWith({ knowledgeBaseId: 'ABCDE12345' })),
      ).toThrow(/Missing required context value 'kbMode'/);
    });

    it.each([
      ['unknown string', 'managed'],
      ['empty string', ''],
      ['numeric', 42],
    ])('rejects an %s mode', (_label, kbMode) => {
      expect(() => resolveKnowledgeBaseSelection(appWith({ kbMode }))).toThrow();
    });
  });

  it('includes usage guidance in every failure', () => {
    // The error is the only documentation an operator sees at the moment they need
    // it, so it carries both invocations rather than pointing at a file.
    try {
      resolveKnowledgeBaseSelection(appWith({}));
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('kbMode=byo');
      expect(message).toContain('kbMode=sample');
    }
  });
});
