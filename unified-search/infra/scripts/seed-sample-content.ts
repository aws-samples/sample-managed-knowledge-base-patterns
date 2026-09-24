#!/usr/bin/env tsx
/**
 * Uploads the sample documents and generates the global ACL file.
 *
 * Run after `cdk deploy` in `sample` mode:
 *
 *   npm run seed:sample -- --stage dev
 *
 * A script rather than a `BucketDeployment` construct. That construct provisions a
 * Lambda-backed custom resource whose role uses an AWS managed policy and broad S3
 * permissions, which cdk-nag reports. Because this sample demonstrates least
 * privilege, sample data is seeded separately.
 *
 * The ACL file is generated here rather than committed because every `keyPrefix`
 * must contain the real bucket name, which is only known after deployment. A
 * committed file with a placeholder would match no document, and with ACL enabled
 * a document with no matching entry is not ingested, so the data source would
 * sync and index nothing.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildGlobalAcl,
  CONTENT_PREFIX,
  GLOBAL_ACL_KEY,
  SEED_ACL,
} from '../lib/seed-acl';
import { generateCorpus } from '../lib/seed-corpus';
import { ATTRIBUTE_NAMES, buildSidecar, sidecarKey } from '../lib/seed-metadata';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function aws(args: readonly string[]): string {
  return execFileSync('aws', [...args], { encoding: 'utf8' }).trim();
}

function resolveBucketName(stackName: string): string {
  const raw = aws([
    'cloudformation',
    'describe-stacks',
    '--stack-name',
    stackName,
    '--query',
    "Stacks[0].Outputs[?OutputKey=='ContentBucketName'].OutputValue",
    '--output',
    'text',
  ]);

  if (raw === '' || raw === 'None') {
    throw new Error(
      `Stack ${stackName} has no ContentBucketName output. Deploy in sample mode first:\n` +
        '  make sample-deploy',
    );
  }
  return raw;
}

function main(): void {
  const stage = arg('stage', 'dev');
  const stackName = arg('stack', `UnifiedSearch-${stage}-KnowledgeBase`);

  const bucket = resolveBucketName(stackName);
  process.stdout.write(`Seeding s3://${bucket}\n`);

  // `__dirname`, not `import.meta.dirname`: this package compiles to CommonJS.
  const committedDir = join(__dirname, '..', 'assets', 'seed', 'content');

  /**
   * Both halves of the corpus are staged into one directory and uploaded once.
   *
   * The committed documents are hand-written and referenced by name in the ACL suite; the
   * rest are generated so that search has enough to rank. They have to arrive in a single
   * `s3 sync --delete`, because two syncs with `--delete` would each remove the other's
   * files — leaving whichever ran last, and an index missing most of the corpus.
   */
  const staging = mkdtempSync(join(tmpdir(), 'unified-search-corpus-'));
  cpSync(committedDir, staging, { recursive: true });

  const generated = generateCorpus();
  for (const document of generated) {
    // Keys are relative to the bucket, so strip the prefix the sync target already adds.
    const relative = document.key.slice(CONTENT_PREFIX.length);
    const destination = join(staging, relative);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, document.body, 'utf8');

    /**
     * The metadata sidecar, staged beside its document so the single sync carries both.
     *
     * Sidecars belong inside the crawled prefix, which the global ACL file deliberately
     * does not: the connector counts them as metadata rather than documents, so they are
     * not ingested and cannot be returned as a search result. Being inside also means a
     * sidecar inherits the ACL entry covering its department prefix, which is what keeps
     * a document's attributes on the same side of the permission boundary as the
     * document itself.
     */
    const sidecar = buildSidecar(document.attributes);
    writeFileSync(
      sidecarKey(destination),
      `${JSON.stringify(sidecar, null, 2)}\n`,
      'utf8',
    );
  }

  // Content first, then the ACL file. Order does not affect correctness — nothing
  // is ingested until an ingestion job runs — but uploading content first means a
  // partial failure leaves no ACL file, and a data source with no ACL file ingests
  // nothing rather than ingesting documents whose permissions are unknown.
  aws(['s3', 'sync', staging, `s3://${bucket}/${CONTENT_PREFIX}`, '--delete']);
  process.stdout.write(
    `  uploaded ${CONTENT_PREFIX} — ${String(generated.length)} generated + ` +
      'the hand-written documents, each with a .metadata.json sidecar\n',
  );
  process.stdout.write(`    filterable attributes: ${ATTRIBUTE_NAMES.join(', ')}\n`);

  const acl = buildGlobalAcl(bucket);
  const scratch = mkdtempSync(join(tmpdir(), 'unified-search-seed-'));
  const aclPath = join(scratch, 'global-acl.json');
  writeFileSync(aclPath, `${JSON.stringify(acl, null, 2)}\n`, 'utf8');

  aws(['s3', 'cp', aclPath, `s3://${bucket}/${GLOBAL_ACL_KEY}`]);
  process.stdout.write(`  uploaded ${GLOBAL_ACL_KEY}\n`);

  for (const entry of SEED_ACL) {
    process.stdout.write(`    ${entry.prefix} -> ${entry.allow.join(', ')}\n`);
  }

  process.stdout.write(
    '\nSeeded. Nothing is searchable until an ingestion job completes. Start one and\n' +
      'wait for it with:\n' +
      `  make sample-ingest STAGE=${stage}\n` +
      `  (or, from infra/: npm run ingest:sample -- --stage ${stage})\n`,
  );
}

main();
