import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';

/** The pattern directory. */
export const PATTERN_DIR = path.join(__dirname, '..', '..');

/**
 * The context of infra/cdk.json. `new cdk.App()` in a test doesn't read cdk.json, so
 * without it tests would synthesize with different feature flags than the CLI.
 */
const CDK_JSON_CONTEXT = (
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8')) as {
    context: Record<string, unknown>;
  }
).context;

/** An App with the infra/cdk.json context plus the given context values. */
export function newApp(context: Record<string, unknown> = {}): cdk.App {
  return new cdk.App({ context: { ...CDK_JSON_CONTEXT, ...context } });
}

export const EXAMPLE_ACCOUNT = '123456789012';
export const EXAMPLE_REGION = 'us-east-1';
export const EXAMPLE_PRINCIPAL = `arn:aws:iam::${EXAMPLE_ACCOUNT}:role/ExampleOperatorRole`;
/**
 * A second account for mismatch cases. Built at run time, so the repository holds no
 * 12-digit number other than the documentation example account.
 */
export const OTHER_ACCOUNT = '9'.repeat(12);
