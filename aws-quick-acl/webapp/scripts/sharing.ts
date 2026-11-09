/**
 * Pure evaluation for check-sharing.ts: given Quick spaces, managed knowledge bases,
 * their permissions and the resources attached to each space, decide whether the demo
 * setup is ready.
 */

export interface Grant {
  /** Principal ARN from Describe*Permissions. */
  readonly principal: string;
  readonly actions: readonly string[];
}

interface ResourceBase {
  readonly id: string;
  readonly name: string;
  readonly grants: readonly Grant[];
}

export interface SpaceResource extends ResourceBase {
  readonly kind: 'space';
  /** ARNs of the resources attached to the space, from ListSpaceResources. */
  readonly attachedArns: readonly string[];
}

export interface KnowledgeBaseResource extends ResourceBase {
  readonly kind: 'knowledge base';
  readonly arn: string;
}

export type SharedResource = SpaceResource | KnowledgeBaseResource;

export interface SharingRow {
  readonly kind: SharedResource['kind'];
  readonly id: string;
  readonly name: string;
  /** Actions each user holds directly, or undefined if the user has no grant. */
  readonly userA: readonly string[] | undefined;
  readonly userB: readonly string[] | undefined;
  /** Both users have a grant, and the two grants hold the same actions. */
  readonly sharedIdentically: boolean;
  /** For a space: IDs of the managed knowledge bases attached to it. */
  readonly knowledgeBaseIds: readonly string[];
}

export interface SharingResult {
  readonly rows: readonly SharingRow[];
  /** A space and a knowledge base attached to it, both shared identically, if any. */
  readonly ready:
    { readonly spaceId: string; readonly knowledgeBaseId: string } | undefined;
}

function actionsFor(grants: readonly Grant[], principal: string): string[] | undefined {
  const matching = grants.filter((g) => g.principal === principal);
  if (!matching.length) return undefined;
  return [...new Set(matching.flatMap((g) => g.actions))].sort();
}

function sameActions(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
) {
  return !!a && !!b && a.length === b.length && a.every((action, i) => action === b[i]);
}

/**
 * A space resource is identified by ARN. Matching on the trailing ID as well keeps the
 * check working if the space reports the knowledge base ARN in a different form.
 */
function isAttached(space: SpaceResource, kb: KnowledgeBaseResource): boolean {
  return space.attachedArns.some((arn) => arn === kb.arn || arn.endsWith(`/${kb.id}`));
}

/**
 * The demo needs one space and one knowledge base attached to that space, each shared
 * with both users with identical actions. Anything short of that means a demo user has
 * no path to the knowledge base, or the two users differ in Quick access, and chat
 * results stop demonstrating the ACLs.
 */
export function evaluateSharing(
  resources: readonly SharedResource[],
  userAArn: string,
  userBArn: string,
): SharingResult {
  const knowledgeBases = resources.filter(
    (r): r is KnowledgeBaseResource => r.kind === 'knowledge base',
  );

  const rows: SharingRow[] = resources.map((r) => {
    const userA = actionsFor(r.grants, userAArn);
    const userB = actionsFor(r.grants, userBArn);
    return {
      kind: r.kind,
      id: r.id,
      name: r.name,
      userA,
      userB,
      sharedIdentically: sameActions(userA, userB),
      knowledgeBaseIds:
        r.kind === 'space'
          ? knowledgeBases.filter((kb) => isAttached(r, kb)).map((kb) => kb.id)
          : [],
    };
  });

  const sharedKbIds = new Set(
    rows
      .filter((r) => r.kind === 'knowledge base' && r.sharedIdentically)
      .map((r) => r.id),
  );

  let ready: SharingResult['ready'];
  for (const row of rows) {
    if (row.kind !== 'space' || !row.sharedIdentically) continue;
    const knowledgeBaseId = row.knowledgeBaseIds.find((id) => sharedKbIds.has(id));
    if (knowledgeBaseId) {
      ready = { spaceId: row.id, knowledgeBaseId };
      break;
    }
  }

  return { rows, ready };
}
