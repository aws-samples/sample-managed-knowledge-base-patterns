/**
 * Read-only check for Phase 3 steps 3 and 4: is the Quick knowledge base attached to a
 * space, and are both shared with both demo users with identical actions?
 *
 * Lists every Quick space (with the resources attached to it) and every managed
 * (Bedrock) knowledge base in the account, and prints the actions each of the two
 * configured users holds on each one. Makes no changes. Uses the same webapp/.env as
 * the harness.
 *
 *   npm run check:sharing --workspace webapp
 *
 * Limits:
 * - Only direct user grants are detected. A grant made to a Quick group that contains
 *   the user is not expanded, and shows as missing.
 * - It checks that the two users' actions are identical, not that those actions permit
 *   querying. Share the knowledge base as Viewer, as the README describes.
 */

import { config as loadDotenv } from 'dotenv';
import {
  DescribeKnowledgeBasePermissionsCommand,
  DescribeSpacePermissionsCommand,
  ListKnowledgeBasesCommand,
  ListSpaceResourcesCommand,
  ListSpacesCommand,
  QuickSightClient,
  type ResourcePermission,
} from '@aws-sdk/client-quicksight';
import { ConfigError, loadConfig, type HarnessConfig } from '../server/config.ts';
import {
  evaluateSharing,
  type Grant,
  type KnowledgeBaseResource,
  type SharingRow,
  type SpaceResource,
} from './sharing.ts';

/** The Quick-side type of a knowledge base created from a Bedrock managed KB. */
const MANAGED_KB_TYPE = 'FULLY_MANAGED_KNOWLEDGE_BASE';

loadDotenv({ quiet: true });

let config: HarnessConfig;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const client = new QuickSightClient({ region: config.region });
const AwsAccountId = config.accountId;

function toGrants(permissions: readonly ResourcePermission[] | undefined): Grant[] {
  return (permissions ?? []).flatMap((p) =>
    p.Principal ? [{ principal: p.Principal, actions: p.Actions ?? [] }] : [],
  );
}

async function listSpaces(): Promise<SpaceResource[]> {
  const out: SpaceResource[] = [];
  let NextToken: string | undefined;
  do {
    const page = await client.send(new ListSpacesCommand({ AwsAccountId, NextToken }));
    for (const s of page.SpaceSummaries ?? []) {
      if (!s.spaceId) continue;
      const SpaceId = s.spaceId;
      const [perms, attached] = await Promise.all([
        client.send(new DescribeSpacePermissionsCommand({ AwsAccountId, SpaceId })),
        client.send(new ListSpaceResourcesCommand({ AwsAccountId, SpaceId })),
      ]);
      out.push({
        kind: 'space',
        id: SpaceId,
        name: s.name ?? '(unnamed)',
        grants: toGrants(perms.Permissions),
        attachedArns: (attached.SpaceResources ?? []).flatMap((r) =>
          r.ResourceType === 'KNOWLEDGE_BASE' && r.ResourceDetails?.resourceArn
            ? [r.ResourceDetails.resourceArn]
            : [],
        ),
      });
    }
    NextToken = page.NextToken;
  } while (NextToken);
  return out;
}

async function listManagedKnowledgeBases(): Promise<KnowledgeBaseResource[]> {
  const out: KnowledgeBaseResource[] = [];
  let NextToken: string | undefined;
  do {
    const page = await client.send(
      new ListKnowledgeBasesCommand({ AwsAccountId, NextToken }),
    );
    for (const kb of page.KnowledgeBaseSummaries ?? []) {
      if (!kb.KnowledgeBaseId || kb.Type !== MANAGED_KB_TYPE) continue;
      const perms = await client.send(
        new DescribeKnowledgeBasePermissionsCommand({
          AwsAccountId,
          KnowledgeBaseId: kb.KnowledgeBaseId,
        }),
      );
      out.push({
        kind: 'knowledge base',
        id: kb.KnowledgeBaseId,
        arn: kb.KnowledgeBaseArn ?? '',
        name: kb.Name ?? '(unnamed)',
        grants: toGrants(perms.Permissions),
      });
    }
    NextToken = page.NextToken;
  } while (NextToken);
  return out;
}

const userA = config.users.get('a')!.arn;
const userB = config.users.get('b')!.arn;

const [spaces, knowledgeBases] = await Promise.all([
  listSpaces(),
  listManagedKnowledgeBases(),
]);
const { rows, ready } = evaluateSharing([...spaces, ...knowledgeBases], userA, userB);

if (!knowledgeBases.length) {
  console.log(
    `No Quick knowledge base of type ${MANAGED_KB_TYPE} found. Complete Phase 3 step 2 first.`,
  );
}

const mark = (ok: boolean) => (ok ? 'yes' : 'NO ');
const label = (r: SharingRow) => `${r.name} (${r.id})`;

console.log('\nkind             user A  user B  identical  name (id)');
for (const r of rows) {
  const contains =
    r.kind === 'space'
      ? `  contains: ${r.knowledgeBaseIds.length ? r.knowledgeBaseIds.join(', ') : 'no managed knowledge base'}`
      : '';
  console.log(
    `${r.kind.padEnd(16)} ${mark(!!r.userA)}     ${mark(!!r.userB)}     ` +
      `${mark(r.sharedIdentically)}        ${label(r)}${contains}`,
  );
}

// Print the actions wherever the two users differ, so a mismatch is actionable.
for (const r of rows) {
  if (r.sharedIdentically || (!r.userA && !r.userB)) continue;
  console.log(`\n${r.kind} ${label(r)}:`);
  console.log(`  user A: ${r.userA?.join(', ') ?? '(no grant)'}`);
  console.log(`  user B: ${r.userB?.join(', ') ?? '(no grant)'}`);
}

if (ready) {
  const space = rows.find((r) => r.kind === 'space' && r.id === ready.spaceId)!;
  const kb = rows.find(
    (r) => r.kind === 'knowledge base' && r.id === ready.knowledgeBaseId,
  )!;
  console.log(
    `\nOK: space ${label(space)} contains knowledge base ${label(kb)}, and both are ` +
      'shared with both users with identical actions.\n' +
      'This does not check that those actions permit querying: share the knowledge base ' +
      'as Viewer.\n',
  );
} else {
  console.log(
    '\nNOT READY: attach the knowledge base to a space (Phase 3 step 3), then share the ' +
      'space AND the knowledge base with both demo users, with identical permissions ' +
      '(Phase 3 step 4).\n' +
      'Grants made to a group are not expanded by this check.\n',
  );
  process.exitCode = 1;
}
