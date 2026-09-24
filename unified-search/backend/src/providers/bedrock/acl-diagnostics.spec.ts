import type { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { ResourceNotFoundException } from '@aws-sdk/client-bedrock-agent-runtime';
import { describe, expect, it } from 'vitest';

import { SourceUnavailableError } from '../../domain/index.js';
import { AclDiagnostics } from './acl-diagnostics.js';

/**
 * The interesting logic here is flattening the nested membership structure the service
 * returns, and preserving the asymmetry between the two operations: a nonexistent
 * document throws from `GetIngestedDocumentAcl` but reports `hasAccess: false` from
 * `CheckIngestedDocumentAcl`. The CLI depends on that difference to distinguish "not
 * permitted" from "not ingested", so it is pinned here.
 */

class FakeClient {
  readonly sent: unknown[] = [];
  constructor(private readonly responses: readonly unknown[]) {}

  send(command: unknown): Promise<unknown> {
    this.sent.push(command);
    const next = this.responses[this.sent.length - 1];
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? {});
  }
}

function build(responses: readonly unknown[]) {
  const client = new FakeClient(responses);
  const diagnostics = new AclDiagnostics(
    client as unknown as BedrockAgentRuntimeClient,
    'KB1234567',
    'DS1234567',
  );
  return { diagnostics, client };
}

describe('AclDiagnostics', () => {
  describe('check', () => {
    it('reports the service decision', async () => {
      const { diagnostics } = build([{ hasAccess: true }]);

      await expect(
        diagnostics.check('s3://b/k.md', 'alejandro_rosalez@example.com'),
      ).resolves.toEqual({
        documentId: 's3://b/k.md',
        userId: 'alejandro_rosalez@example.com',
        hasAccess: true,
      });
    });

    it('treats an absent hasAccess as denied', async () => {
      const { diagnostics } = build([{}]);

      // Failing closed is the only safe reading of a missing decision.
      const result = await diagnostics.check(
        's3://b/k.md',
        'alejandro_rosalez@example.com',
      );
      expect(result.hasAccess).toBe(false);
    });

    it('translates a service exception into a domain error', async () => {
      const { diagnostics } = build([
        new ResourceNotFoundException({ message: 'gone', $metadata: {} }),
      ]);

      await expect(
        diagnostics.check('s3://b/k.md', 'alejandro_rosalez@example.com'),
      ).rejects.toBeInstanceOf(SourceUnavailableError);
    });
  });

  describe('listAcl', () => {
    it('flattens users out of the nested condition structure', async () => {
      const { diagnostics } = build([
        {
          documentAcl: {
            allowList: {
              memberRelation: 'AND',
              conditions: [
                {
                  conditionOperator: 'OR',
                  users: [
                    { id: 'akua_mansa@example.com', type: 'KNOWLEDGE_BASE' },
                    { id: 'alejandro_rosalez@example.com', type: 'KNOWLEDGE_BASE' },
                  ],
                },
              ],
            },
          },
        },
      ]);

      const result = await diagnostics.listAcl('s3://b/k.md');

      expect(result.allowed).toEqual([
        { id: 'akua_mansa@example.com', type: 'KNOWLEDGE_BASE' },
        { id: 'alejandro_rosalez@example.com', type: 'KNOWLEDGE_BASE' },
      ]);
      expect(result.denied).toEqual([]);
    });

    it('includes groups alongside users, and spans several conditions', async () => {
      const { diagnostics } = build([
        {
          documentAcl: {
            allowList: {
              conditions: [
                { users: [{ id: 'alejandro_rosalez@example.com' }] },
                { groups: [{ id: 'finance', type: 'KNOWLEDGE_BASE' }] },
              ],
            },
            denyList: { conditions: [{ users: [{ id: 'contractor@example.com' }] }] },
          },
        },
      ]);

      const result = await diagnostics.listAcl('s3://b/k.md');

      expect(result.allowed.map((principal) => principal.id)).toEqual([
        'alejandro_rosalez@example.com',
        'finance',
      ]);
      // Deny is surfaced separately because deny overrides allow, so a principal
      // appearing in both is denied.
      expect(result.denied.map((principal) => principal.id)).toEqual([
        'contractor@example.com',
      ]);
    });

    it('returns empty lists for a document with no recorded entries', async () => {
      const { diagnostics } = build([{ documentAcl: {} }]);

      await expect(diagnostics.listAcl('s3://b/k.md')).resolves.toEqual({
        documentId: 's3://b/k.md',
        allowed: [],
        denied: [],
      });
    });

    it('skips principals with no id rather than emitting a blank entry', async () => {
      const { diagnostics } = build([
        {
          documentAcl: {
            allowList: { conditions: [{ users: [{ type: 'KNOWLEDGE_BASE' }] }] },
          },
        },
      ]);

      expect((await diagnostics.listAcl('s3://b/k.md')).allowed).toEqual([]);
    });

    /**
     * The asymmetry the CLI relies on: this operation throws for a document that is
     * not in the knowledge base, whereas `check` would have reported plain denial.
     */
    it('throws for a document that is not ingested', async () => {
      const { diagnostics } = build([
        new ResourceNotFoundException({
          message: 'Document not found in the knowledge base',
          $metadata: {},
        }),
      ]);

      await expect(diagnostics.listAcl('s3://b/missing.md')).rejects.toBeInstanceOf(
        SourceUnavailableError,
      );
    });
  });
});
