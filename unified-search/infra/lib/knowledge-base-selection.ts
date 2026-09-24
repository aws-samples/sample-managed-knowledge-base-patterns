import type { App } from 'aws-cdk-lib';

/**
 * How this deployment obtains its knowledge base.
 *
 * - `byo` — the operator supplies an existing knowledge base ID. Nothing is
 *   provisioned and nothing about their knowledge base is modified.
 * - `sample` — a managed knowledge base with an ACL-enabled Amazon S3 data
 *   source is provisioned, so the sample can be evaluated from a clean account.
 */
export type KnowledgeBaseMode = 'byo' | 'sample';

export type KnowledgeBaseSelection =
  | { readonly mode: 'byo'; readonly knowledgeBaseId: string }
  | { readonly mode: 'sample' };

/**
 * Knowledge base IDs are exactly ten alphanumeric characters.
 *
 * Matches the pattern CloudFormation enforces on the resource. Validating here
 * turns a mistyped ID into a synth-time error rather than a stack that deploys
 * and then fails every query at runtime.
 */
const KNOWLEDGE_BASE_ID_PATTERN = /^[0-9a-zA-Z]{10}$/;

const USAGE = [
  'Specify the knowledge base mode explicitly:',
  '',
  '  Bring your own (nothing is provisioned, your knowledge base is not modified):',
  '    npm run synth:byo',
  '    cdk deploy -c kbMode=byo -c knowledgeBaseId=ABCDE12345',
  '',
  '  Deploy a sample one (managed KB + ACL-enabled S3 data source):',
  '    npm run deploy:sample',
  '    cdk deploy -c kbMode=sample',
  '',
  'Every CDK command synthesizes the app, so even commands that do not read a',
  'stack — bootstrap, ls, doctor — need a mode. Use `npm run bootstrap`, which',
  'supplies an inert placeholder for exactly that reason.',
].join('\n');

/**
 * Resolves the knowledge base mode from CDK context.
 *
 * The mode is **required and never inferred**. Treating "no ID supplied" as
 * "create one for me" would mean a typo in a context key silently provisions a
 * knowledge base and begins incurring ingestion and storage charges, which is
 * not a failure mode worth the convenience.
 *
 * @throws {Error} when the mode is absent, unrecognized, or inconsistent with
 * the other context values.
 */
export function resolveKnowledgeBaseSelection(app: App): KnowledgeBaseSelection {
  const rawMode: unknown = app.node.tryGetContext('kbMode');
  const rawId: unknown = app.node.tryGetContext('knowledgeBaseId');

  if (rawMode === undefined || rawMode === '') {
    throw new Error(`Missing required context value 'kbMode'.\n\n${USAGE}`);
  }
  if (typeof rawMode !== 'string') {
    throw new Error(`Context value 'kbMode' must be a string.\n\n${USAGE}`);
  }

  const mode = rawMode.trim().toLowerCase();

  if (mode === 'byo') {
    if (typeof rawId !== 'string' || rawId.trim() === '') {
      throw new Error(
        `kbMode=byo requires context value 'knowledgeBaseId'.\n\n${USAGE}`,
      );
    }
    const knowledgeBaseId = rawId.trim();
    if (!KNOWLEDGE_BASE_ID_PATTERN.test(knowledgeBaseId)) {
      throw new Error(
        `'knowledgeBaseId' must be 10 alphanumeric characters, got '${knowledgeBaseId}'.`,
      );
    }
    return { mode: 'byo', knowledgeBaseId };
  }

  if (mode === 'sample') {
    // Supplying an ID in sample mode is contradictory: either the operator meant
    // byo and mistyped the mode, or they expect their existing knowledge base to
    // be adopted, which this stack will not do. Failing is the only safe reading.
    if (typeof rawId === 'string' && rawId.trim() !== '') {
      throw new Error(
        `kbMode=sample provisions a new knowledge base, so 'knowledgeBaseId' must ` +
          `not be set. Did you mean -c kbMode=byo?\n\n${USAGE}`,
      );
    }
    return { mode: 'sample' };
  }

  throw new Error(
    `Unrecognized kbMode '${rawMode}'. Expected 'byo' or 'sample'.\n\n${USAGE}`,
  );
}
