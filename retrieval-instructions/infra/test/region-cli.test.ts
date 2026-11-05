import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EXAMPLE_ACCOUNT } from './support';

// Proves that AWS_REGION reaches the app through the pinned CDK CLI, and that the
// CLI's own Region fallbacks (AWS_DEFAULT_REGION, the profile) don't. No AWS calls:
// the child gets an environment built from scratch, an empty AWS config, and no
// instance metadata, so neither CI runners nor a developer profile leak in.

const INFRA_DIR = path.join(__dirname, '..');
const CDK_CLI = createRequire(__filename).resolve('aws-cdk/bin/cdk');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'region-cli-'));
const emptyConfig = path.join(tmp, 'empty-aws-config');
fs.writeFileSync(emptyConfig, '');

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function synthEnvironment(
  regionVariables: Record<string, string>,
  name: string,
): string {
  const output = path.join(tmp, name);
  const result = spawnSync(
    process.execPath,
    [
      CDK_CLI,
      'synth',
      '--quiet',
      '--no-notices',
      '-c',
      `account=${EXAMPLE_ACCOUNT}`,
      '--output',
      output,
    ],
    {
      cwd: INFRA_DIR,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? tmp,
        AWS_EC2_METADATA_DISABLED: 'true',
        AWS_CONFIG_FILE: emptyConfig,
        AWS_SHARED_CREDENTIALS_FILE: emptyConfig,
        CDK_DISABLE_CLI_TELEMETRY: 'true',
        CDK_DISABLE_VERSION_CHECK: 'true',
        ...regionVariables,
      },
    },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'),
  ) as {
    artifacts: Record<string, { environment?: string }>;
  };
  return manifest.artifacts.RetrievalInstructionsSample?.environment ?? '';
}

describe('CDK CLI Region', () => {
  it('deploys to AWS_REGION when it is set', { timeout: 120_000 }, () => {
    expect(synthEnvironment({ AWS_REGION: 'eu-west-2' }, 'aws-region')).toBe(
      `aws://${EXAMPLE_ACCOUNT}/eu-west-2`,
    );
  });

  it(
    'ignores AWS_DEFAULT_REGION and defaults to us-east-1',
    { timeout: 120_000 },
    () => {
      expect(
        synthEnvironment({ AWS_DEFAULT_REGION: 'eu-west-1' }, 'default-region'),
      ).toBe(`aws://${EXAMPLE_ACCOUNT}/us-east-1`);
    },
  );
});
