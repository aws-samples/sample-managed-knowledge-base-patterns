import { describe, expect, it } from 'vitest';
import {
  evaluateSharing,
  type Grant,
  type KnowledgeBaseResource,
  type SpaceResource,
} from '../scripts/sharing.ts';

const A = 'arn:aws:quicksight:us-east-1:123456789012:user/default/martha_rivera';
const B = 'arn:aws:quicksight:us-east-1:123456789012:user/default/mateo_jackson';
const ADMIN = 'arn:aws:quicksight:us-east-1:123456789012:user/default/admin';
const KB_ARN = 'arn:aws:quicksight:us-east-1:123456789012:knowledgebase/k1';

// Placeholder action names. The check compares actions between the two users without
// interpreting them, so the exact strings do not matter here.
const VIEW = ['quicksight:DescribeKnowledgeBase', 'quicksight:QueryKnowledgeBase'];
const OWN = [...VIEW, 'quicksight:UpdateKnowledgeBase'];

const grant = (principal: string, actions: string[] = VIEW): Grant => ({
  principal,
  actions,
});

const space = (grants: Grant[], attachedArns: string[] = [KB_ARN]): SpaceResource => ({
  kind: 'space',
  id: 's1',
  name: 'Demo space',
  grants,
  attachedArns,
});
const kb = (grants: Grant[]): KnowledgeBaseResource => ({
  kind: 'knowledge base',
  id: 'k1',
  arn: KB_ARN,
  name: 'Demo KB',
  grants,
});

const bothUsers = () => [grant(ADMIN, OWN), grant(A), grant(B)];

describe('sharing check', () => {
  it('is ready when the space contains the knowledge base and both are shared identically', () => {
    const { ready } = evaluateSharing([space(bothUsers()), kb(bothUsers())], A, B);
    expect(ready).toEqual({ spaceId: 's1', knowledgeBaseId: 'k1' });
  });

  it('is not ready when only the admin has access, as the console leaves it', () => {
    const { rows, ready } = evaluateSharing(
      [space([grant(ADMIN)]), kb([grant(ADMIN)])],
      A,
      B,
    );

    expect(rows.map((r) => [r.userA, r.userB])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
    ]);
    expect(ready).toBeUndefined();
  });

  it('is not ready when the space is shared but the knowledge base is not', () => {
    const { ready } = evaluateSharing([space(bothUsers()), kb([grant(ADMIN)])], A, B);
    expect(ready).toBeUndefined();
  });

  it('is not ready when one user is missing from one resource', () => {
    const { ready } = evaluateSharing([space(bothUsers()), kb([grant(A)])], A, B);
    expect(ready).toBeUndefined();
  });

  it('is not ready when the shared knowledge base is not in the shared space', () => {
    const { rows, ready } = evaluateSharing(
      [space(bothUsers(), []), kb(bothUsers())],
      A,
      B,
    );

    expect(rows[0]?.knowledgeBaseIds).toEqual([]);
    expect(ready).toBeUndefined();
  });

  it('ignores a space that contains some other knowledge base', () => {
    const other = 'arn:aws:quicksight:us-east-1:123456789012:knowledgebase/k2';
    const { ready } = evaluateSharing(
      [space(bothUsers(), [other]), kb(bothUsers())],
      A,
      B,
    );
    expect(ready).toBeUndefined();
  });

  it('matches an attached knowledge base by trailing ID when the ARN form differs', () => {
    const { ready } = evaluateSharing(
      [
        space(bothUsers(), ['arn:aws:quicksight:us-east-1:123456789012:kb/k1']),
        kb(bothUsers()),
      ],
      A,
      B,
    );
    expect(ready).toEqual({ spaceId: 's1', knowledgeBaseId: 'k1' });
  });

  it('is not ready when the two users hold different actions', () => {
    const { rows, ready } = evaluateSharing(
      [space(bothUsers()), kb([grant(A, OWN), grant(B, VIEW)])],
      A,
      B,
    );

    expect(rows[1]?.sharedIdentically).toBe(false);
    expect(rows[1]?.userA).toEqual([...OWN].sort());
    expect(ready).toBeUndefined();
  });

  it('treats the same actions in a different order, or split across grants, as identical', () => {
    const { ready } = evaluateSharing(
      [
        space(bothUsers()),
        kb([grant(A, [...VIEW].reverse()), grant(B, [VIEW[0]!]), grant(B, [VIEW[1]!])]),
      ],
      A,
      B,
    );
    expect(ready).toBeDefined();
  });
});
