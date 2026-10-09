/**
 * Renders seed-data/acl/global-acl.template.json into a deployable global-acl.json by
 * substituting the data bucket name and the two demo user email addresses.
 *
 * Usage:
 *   npm run seed:render                                   # bucket from cdk-outputs.json
 *   npm run seed:render -- --bucket amzn-s3-demo-bucket   # bucket supplied explicitly
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { AclRenderError, renderAcl } from '../lib/acl-render';

config({ quiet: true });

const infraRoot = resolve(__dirname, '..');
const TEMPLATE = resolve(infraRoot, 'seed-data/acl/global-acl.template.json');
const OUTPUT = resolve(infraRoot, 'seed-data/acl/global-acl.json');
const OUTPUTS_FILE = resolve(infraRoot, 'cdk-outputs.json');

function fail(message: string): never {
  console.error(`\nerror: ${message}\n`);
  process.exit(1);
}

function resolveBucketName(): string {
  const flagIndex = process.argv.indexOf('--bucket');
  if (flagIndex !== -1) {
    const value = process.argv[flagIndex + 1];
    if (!value) fail('--bucket was given without a value.');
    return value;
  }

  if (!existsSync(OUTPUTS_FILE)) {
    fail(
      'cdk-outputs.json not found. Deploy the stack first with `npm run deploy`, or pass\n' +
        'the bucket explicitly: npm run seed:render -- --bucket <bucket-name>',
    );
  }

  const outputs = JSON.parse(readFileSync(OUTPUTS_FILE, 'utf8')) as {
    ManagedKbStack?: { DataBucketName?: string };
  };
  const bucket = outputs.ManagedKbStack?.DataBucketName;
  if (!bucket) {
    fail('DataBucketName not present in cdk-outputs.json. Re-run `npm run deploy`.');
  }
  return bucket;
}

const bucketName = resolveBucketName();

let rendered: string;
try {
  rendered = renderAcl(readFileSync(TEMPLATE, 'utf8'), {
    bucketName,
    userAEmail: process.env.DEMO_USER_A_EMAIL,
    userBEmail: process.env.DEMO_USER_B_EMAIL,
  });
} catch (err) {
  if (err instanceof AclRenderError) fail(err.message);
  throw err;
}

writeFileSync(OUTPUT, rendered);

console.log(`Wrote ${OUTPUT}`);
console.log(`  bucket: ${bucketName}`);
console.log(`  user A: ${process.env.DEMO_USER_A_EMAIL?.trim()}  (shared/, finance/)`);
console.log(
  `  user B: ${process.env.DEMO_USER_B_EMAIL?.trim()}  (shared/, engineering/)`,
);
console.log('\nNext, upload the corpus and the ACL file:\n');
console.log(
  `  aws s3 sync ./seed-data s3://${bucketName}/ --exclude "acl/global-acl.template.json" --exclude "*.DS_Store"\n`,
);
