#!/usr/bin/env node
/**
 * Operator CLI for debugging document-level access control.
 *
 * Not an HTTP endpoint, deliberately. `GetIngestedDocumentAcl` returns the full allow
 * list for a document — including other users' email addresses — and this application
 * has authentication but no authorization model, so any signed-in user could otherwise
 * enumerate who may read what. As a CLI it runs with the operator's own AWS credentials,
 * which puts access under IAM where an administrative capability belongs, and leaves no
 * endpoint to accidentally expose.
 *
 * Run it through `make acl-check`, which resolves the knowledge base and data source
 * from the deployed stack so neither can drift from what is actually running.
 */
// No SDK import here: the Bedrock SDK client is constructed by
// `AclDiagnostics.forRegion`, inside the provider layer, which is the only place
// permitted to import it. ESLint enforces that boundary, so importing
// `BedrockAgentRuntimeClient` directly from this file fails lint.
import { AclDiagnostics } from '../providers/bedrock/acl-diagnostics.js';

const USAGE = `
acl-check — explain why a document is or is not visible to a user

  Access-control filtering is fail-closed by design: documents a user may not read
  are left out of results. A denied document, an empty index and a query with no
  matches therefore return the same empty result. This command queries the
  document's ACL directly to tell them apart.

USAGE
  acl-check --kb <id> --ds <id> --document <s3-uri> [--user <email>]

OPTIONS
  --kb <id>          Knowledge base ID.        Defaults to $KNOWLEDGE_BASE_ID
  --ds <id>          Data source ID.           Defaults to $DATA_SOURCE_ID
  --document <uri>   Document identifier. Must be the s3:// form — the https:// URL
                     in a search result's uri is a display link, not a document
                     identifier.
  --user <email>     Check one user. Omit to list the document's access entries.
  --region <region>  Defaults to $AWS_REGION, then us-east-1
  --json             Machine-readable output
  -h, --help         This text

EXAMPLES
  # Who is allowed to read this document?
  acl-check --document s3://amzn-s3-demo-bucket/content/finance/q3.md

  # Can this specific user read it?
  acl-check --document s3://amzn-s3-demo-bucket/content/finance/q3.md --user alejandro_rosalez@example.com

NOTES
  Listing access entries reveals other users' identities, which is why this is an
  operator tool run under your own credentials rather than an API endpoint.

  Requires bedrock:CheckIngestedDocumentAcl and bedrock:GetIngestedDocumentAcl on the
  knowledge base.

  The access check answers only the access question, so an identifier that is not
  in the knowledge base also reports no access. This command also reads the ACL
  entries to tell "not ingested" apart from "not permitted".
`.trimStart();

interface Options {
  readonly knowledgeBaseId: string;
  readonly dataSourceId: string;
  readonly documentId: string;
  readonly userId?: string;
  readonly region: string;
  readonly json: boolean;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function parseOptions(): Options {
  const knowledgeBaseId = flag('kb') ?? process.env.KNOWLEDGE_BASE_ID ?? '';
  const dataSourceId = flag('ds') ?? process.env.DATA_SOURCE_ID ?? '';
  const documentId = flag('document') ?? '';
  const userId = flag('user');
  const region = flag('region') ?? process.env.AWS_REGION ?? 'us-east-1';

  const missing: string[] = [];
  if (knowledgeBaseId === '') missing.push('--kb (or KNOWLEDGE_BASE_ID)');
  if (dataSourceId === '') missing.push('--ds (or DATA_SOURCE_ID)');
  if (documentId === '') missing.push('--document');
  if (missing.length > 0) {
    throw new Error(
      `Missing required argument(s): ${missing.join(', ')}\n\nRun with --help.`,
    );
  }

  if (!documentId.startsWith('s3://') && !documentId.includes('://')) {
    throw new Error(
      `--document must be a document identifier, got '${documentId}'.\n` +
        'For an S3 data source this is the s3:// form. A search result carries it as ' +
        "the hit's `id`; the `uri` field is an https:// display link, not a document " +
        'identifier.',
    );
  }

  return {
    knowledgeBaseId,
    dataSourceId,
    documentId,
    ...(userId === undefined ? {} : { userId }),
    region,
    json: process.argv.includes('--json'),
  };
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  const options = parseOptions();
  const diagnostics = AclDiagnostics.forRegion(
    options.region,
    options.knowledgeBaseId,
    options.dataSourceId,
  );

  // Always fetch the entries: they are what makes a denial explicable, and a failure
  // here distinguishes "document not ingested" from "user not permitted" — a
  // nonexistent document reports no access from the check but throws from this.
  const acl = await diagnostics.listAcl(options.documentId).catch((error: unknown) => {
    throw new Error(
      `Could not read access entries for ${options.documentId}.\n\n` +
        'The most likely cause is that this document is not in the knowledge base: ' +
        'either the identifier is wrong, or it was never ingested. On an ACL-enabled ' +
        'data source a document with no matching ACL entry is not ingested at all, so ' +
        'check the seed ACL prefixes and the ingestion job statistics.\n\n' +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  if (options.userId === undefined) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(acl, null, 2)}\n`);
      return;
    }
    process.stdout.write(`\n${options.documentId}\n\n`);
    process.stdout.write(`  allowed (${String(acl.allowed.length)}):\n`);
    for (const principal of acl.allowed) {
      process.stdout.write(`    ${principal.id}${suffix(principal.type)}\n`);
    }
    if (acl.denied.length > 0) {
      process.stdout.write(
        `  denied (${String(acl.denied.length)}) — deny overrides allow:\n`,
      );
      for (const principal of acl.denied) {
        process.stdout.write(`    ${principal.id}${suffix(principal.type)}\n`);
      }
    }
    process.stdout.write(
      '\nPass --user <email> to check one identity authoritatively.\n',
    );
    return;
  }

  const result = await diagnostics.check(options.documentId, options.userId);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...result, acl }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`\n${options.documentId}\n`);
  process.stdout.write(
    `  ${options.userId}: ${result.hasAccess ? 'ALLOWED' : 'DENIED'}\n\n`,
  );

  const named = acl.allowed.some(
    (principal) => principal.id.toLowerCase() === options.userId?.toLowerCase(),
  );

  if (!result.hasAccess && !named) {
    process.stdout.write(
      '  This user is not named in the document access entries. Entries match on\n' +
        '  email address and aliases are not resolved, so check that the domain in\n' +
        '  the token matches the domain in the data source.\n\n',
    );
    process.stdout.write(
      `  Entries: ${acl.allowed.map((p) => p.id).join(', ') || '(none)'}\n`,
    );
  } else if (!result.hasAccess && named) {
    process.stdout.write(
      '  This user IS named in the allow entries but access was still denied. Deny\n' +
        '  overrides allow, and group membership is resolved from the last sync, so\n' +
        '  check the deny entries and how recently the data source was synced.\n',
    );
  }
}

function suffix(type: string | undefined): string {
  return type === undefined ? '' : `  (${type})`;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
