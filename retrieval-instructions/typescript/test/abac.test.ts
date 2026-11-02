import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BedrockAgentClient,
  GetRetrievalInstructionCommand,
  TagResourceCommand,
} from '@aws-sdk/client-bedrock-agent';
import type { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { AssumeRoleCommand, type STSClient } from '@aws-sdk/client-sts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHECK_APP_VALUE,
  type Check,
  type Credentials,
  passed,
  verifyAbac,
} from '../src/abac';
import { Deployment } from '../src/deployment';
import { UsageError } from '../src/errors';
import { formatVerifyAbac } from '../src/formats';
import * as stateFile from '../src/state';
import type { State } from '../src/state';
import {
  ACCOUNT,
  FakeRuntime,
  capture,
  fakeClient,
  fixture,
  serviceError,
  tempDir,
} from './support';

const ROLE = `arn:aws:iam::${ACCOUNT}:role/`;
const OUTPUTS: Record<string, string> = {
  SharedKnowledgeBaseId: 'ABCDE12345',
  SharedDataSourceId: 'KLMNO12345',
  CorpusBucketName: 'amzn-s3-demo-bucket',
  TenantRoleTenants: 'sales-region-north',
  ApplierRoleArnSalesRegionNorth: ROLE + 'ExampleApplierRole',
  TenantAdminRoleArnSalesRegionNorth: ROLE + 'ExampleTenantAdminRole',
  PlatformAdminRoleArn: ROLE + 'ExamplePlatformAdminRole',
};
const SECRET = 'example-secret-value';

function stateWithCentral(): State {
  const raw = fixture('state.json');
  raw.instructions['sales-region-central'] = {
    name: 'assistant-sales-region-central',
    id: 'klmno12345',
    arn: `arn:aws:bedrock:us-east-1:${ACCOUNT}:retrieval-instruction/klmno12345`,
    versions: ['1'],
    createdBy: 'python',
  };
  raw.release['sales-region-central'] = { live: '1' };
  return stateFile.parse(raw);
}

class FakeSts {
  readonly calls: Record<string, unknown>[] = [];
  constructor(private readonly deny = false) {}

  client(): STSClient {
    return {
      send: (command: AssumeRoleCommand) => {
        expect(command).toBeInstanceOf(AssumeRoleCommand);
        this.calls.push({ ...command.input });
        if (this.deny) return Promise.reject(serviceError('AccessDenied'));
        const role = String(command.input.RoleArn).split('/').at(-1);
        return Promise.resolve({
          Credentials: {
            AccessKeyId: role,
            SecretAccessKey: SECRET,
            SessionToken: `${SECRET}-token`,
          },
        });
      },
    } as unknown as STSClient;
  }
}

class FakeAgent {
  readonly tagCalls: Record<string, unknown>[] = [];
  readonly getCalls: Record<string, unknown>[] = [];
  constructor(private readonly allowTags = false) {}

  client(): BedrockAgentClient {
    return fakeClient(new BedrockAgentClient({ region: 'us-east-1' }), (command) => {
      if (command instanceof TagResourceCommand) {
        this.tagCalls.push({ ...command.input });
        if (!this.allowTags)
          return Promise.reject(
            serviceError('AccessDeniedException', 'not authorized'),
          );
        return Promise.resolve({});
      }
      expect(command).toBeInstanceOf(GetRetrievalInstructionCommand);
      this.getCalls.push({ ...command.input });
      return Promise.resolve({});
    });
  }
}

class Roles {
  readonly credentials: Credentials[] = [];
  constructor(
    private readonly applier: FakeRuntime,
    private readonly tenantAdmin: FakeAgent,
    private readonly platformAdmin: FakeAgent,
  ) {}

  readonly runtime = (credentials: Credentials): BedrockAgentRuntimeClient => {
    this.credentials.push(credentials);
    expect(credentials.accessKeyId).toBe('ExampleApplierRole');
    return this.applier.client();
  };

  readonly agent = (credentials: Credentials): BedrockAgentClient => {
    this.credentials.push(credentials);
    if (credentials.accessKeyId === 'ExampleTenantAdminRole')
      return this.tenantAdmin.client();
    expect(credentials.accessKeyId).toBe('ExamplePlatformAdminRole');
    return this.platformAdmin.client();
  };
}

let io: ReturnType<typeof capture>;
beforeEach(() => {
  io = capture();
});
afterEach(() => io.restore());

async function run(
  applier: FakeRuntime,
  tenantAdmin: FakeAgent,
  reader: FakeAgent = new FakeAgent(true),
  outputs: Record<string, string> = OUTPUTS,
): Promise<[Check[], Roles, FakeAgent]> {
  const roles = new Roles(applier, tenantAdmin, new FakeAgent());
  const checks = await verifyAbac({
    sts: new FakeSts().client(),
    agent: reader.client(),
    deployment: new Deployment('CREATE_COMPLETE', outputs),
    state: stateWithCentral(),
    tenant: 'sales-region-north',
    other: 'sales-region-central',
    clientFactory: roles,
  });
  return [checks, roles, reader];
}

const denied = (): Error => serviceError('AccessDeniedException', 'denied');

describe('verify-abac', () => {
  it('passes the five checks when the tag conditions hold', async () => {
    const applier = new FakeRuntime('isolation-filtered.json', denied());
    const tenantAdmin = new FakeAgent();
    const [checks, , reader] = await run(applier, tenantAdmin);
    expect(checks.map((c) => [c.role, c.expected, c.observed])).toEqual([
      ['applier', 'allow', 'allow'],
      ['applier', 'deny', 'deny'],
      ['tenant admin', 'deny', 'deny'],
      ['tenant admin', 'deny', 'deny'],
      ['platform admin', 'allow', 'allow'],
    ]);
    expect(checks.every(passed)).toBe(true);
    const [own, other] = applier.calls;
    expect(own?.retrievalInstructionConfiguration).toEqual({
      retrievalInstructionId: 'abcde12345',
      version: '1',
    });
    expect(other?.retrievalInstructionConfiguration).toEqual({
      retrievalInstructionId: 'klmno12345',
      version: '1',
    });
    expect(own?.retrievers).toEqual(other?.retrievers); // the filter stays the authenticated tenant's
    expect(own?.generateResponse).toBe(false);
    const [retag, appTag] = tenantAdmin.tagCalls;
    expect(retag?.tags).toEqual({ tenant: 'sales-region-north' });
    expect(String(retag?.resourceArn).endsWith('klmno12345')).toBe(true);
    expect(appTag?.tags).toEqual({
      tenant: 'sales-region-north',
      app: CHECK_APP_VALUE,
    });
    expect(String(appTag?.resourceArn).endsWith('abcde12345')).toBe(true);
    expect(reader.tagCalls).toEqual([]);
  });

  it('counts an in-stream AccessDeniedException as deny', async () => {
    const [checks] = await run(
      new FakeRuntime('isolation-filtered.json', 'midstream-error.json'),
      new FakeAgent(),
    );
    expect(checks[1]?.observed).toBe('deny');
  });

  it('restores the tags and fails on unexpected allows', async () => {
    const applier = new FakeRuntime(
      'isolation-filtered.json',
      'isolation-filtered.json',
    );
    const [checks, , reader] = await run(applier, new FakeAgent(true));
    expect(checks.map(passed)).toEqual([true, false, false, false, true]);
    expect(reader.tagCalls.map((c) => c.tags)).toEqual([
      { tenant: 'sales-region-central' },
      { app: 'retrieval-instructions-sample' },
    ]);
    expect(
      formatVerifyAbac('sales-region-north', 'sales-region-central', checks),
    ).toContain('FAIL');
  });

  it('prints the fix command when a restore fails', async () => {
    const applier = new FakeRuntime('isolation-filtered.json', denied());
    await run(applier, new FakeAgent(true), new FakeAgent(false));
    expect(io.err()).toContain('aws bedrock-agent tag-resource --resource-arn');
  });

  it('exits 2 for a stack without tenant roles', async () => {
    const outputs = Object.fromEntries(
      Object.entries(OUTPUTS).filter(([k]) => !k.includes('Role')),
    );
    const result = run(new FakeRuntime(), new FakeAgent(), undefined, outputs);
    await expect(result).rejects.toThrow(UsageError);
    await expect(result).rejects.toThrow('trustedPrincipalArn');
  });

  it('exits 2 for an untrusted caller', async () => {
    const result = verifyAbac({
      sts: new FakeSts(true).client(),
      agent: new FakeAgent().client(),
      deployment: new Deployment('CREATE_COMPLETE', OUTPUTS),
      state: stateWithCentral(),
      tenant: 'sales-region-north',
      other: 'sales-region-central',
      clientFactory: new Roles(new FakeRuntime(), new FakeAgent(), new FakeAgent()),
    });
    await expect(result).rejects.toThrow('trusted principal');
  });

  it('keeps every credential out of the output and the state file', async () => {
    const applier = new FakeRuntime('isolation-filtered.json', denied());
    const [checks, roles] = await run(
      applier,
      new FakeAgent(true),
      new FakeAgent(false),
    );
    expect(roles.credentials[0]?.secretAccessKey).toBe(SECRET); // the sessions did use the credentials
    const text = formatVerifyAbac('sales-region-north', 'sales-region-central', checks);
    const [dir, cleanup] = tempDir();
    try {
      const file = path.join(dir, 'sample-state.json');
      stateFile.save(stateWithCentral(), file);
      for (const output of [text, io.out(), io.err(), fs.readFileSync(file, 'utf8')]) {
        expect(output).not.toContain(SECRET);
      }
    } finally {
      cleanup();
    }
  });
});
