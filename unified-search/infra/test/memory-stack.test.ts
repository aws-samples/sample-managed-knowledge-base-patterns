import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { MemoryStack } from '../lib/memory-stack';

/**
 * Conversation memory holds generated answers derived from access-controlled
 * documents, so its configuration is asserted rather than assumed. Isolation itself
 * is a provider property — the actor comes from a verified token — and is asserted
 * by the backend integration suite; what is checkable here is that the resource is
 * encrypted with a key this stack owns and that retention is deliberate.
 */
function synth(props: { eventExpiryDays?: number } = {}): Template {
  const app = new cdk.App();
  const stack = new MemoryStack(app, 'TestMemory', {
    stageName: 'test',
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });
  return Template.fromStack(stack);
}

describe('MemoryStack', () => {
  it('provisions one AgentCore Memory resource', () => {
    synth().resourceCountIs('AWS::BedrockAgentCore::Memory', 1);
  });

  it('encrypts memory with a customer-managed key', () => {
    const template = synth();

    template.resourceCountIs('AWS::KMS::Key', 1);
    // A customer-managed key lets usage of the key be audited and access to it revoked
    // independently of the memory resource. The ARN is
    // a CloudFormation reference to the key in this stack, so match its shape rather
    // than a literal.
    template.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
      EncryptionKeyArn: { 'Fn::GetAtt': Match.arrayWith(['Arn']) },
    });
  });

  it('enables key rotation', () => {
    synth().hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  it('defaults retention to 30 days rather than inheriting the service default', () => {
    // The service default is 90. This resource holds answers derived from
    // access-controlled documents, so retention is chosen, not inherited.
    synth().hasResourceProperties('AWS::BedrockAgentCore::Memory', {
      EventExpiryDuration: 30,
    });
  });

  it('honours an explicit retention period', () => {
    synth({ eventExpiryDays: 7 }).hasResourceProperties(
      'AWS::BedrockAgentCore::Memory',
      {
        EventExpiryDuration: 7,
      },
    );
  });

  it('rejects a retention period outside the supported range, at synth time', () => {
    // Checked at synth time so the error is reported before a stack update starts.
    for (const eventExpiryDays of [0, 6, 366, 1.5]) {
      expect(
        () => synth({ eventExpiryDays }),
        `days=${String(eventExpiryDays)}`,
      ).toThrow(/between 7 and 365/);
    }
  });

  it('configures no memory strategies, so only session history is stored', () => {
    const template = synth();
    const memories = template.findResources('AWS::BedrockAgentCore::Memory');
    const [memory] = Object.values(memories);

    // Long-term extraction is a larger surface and is not what multi-turn chat
    // needs. Enabling it would additionally require an actor-scoped namespace, which
    // the provider refuses to accept without an {actorId} placeholder.
    expect(memory?.Properties).not.toHaveProperty('MemoryStrategies');
  });

  it('restricts the key policy to this account', () => {
    const template = synth();
    const keys = template.findResources('AWS::KMS::Key');
    const [key] = Object.values(keys);
    const statements = (
      key?.Properties as {
        KeyPolicy?: { Statement?: readonly Record<string, unknown>[] };
      }
    ).KeyPolicy?.Statement;

    const agentCore = statements?.find(
      (statement) => statement.Sid === 'AllowAgentCoreMemoryUseOfTheKey',
    );

    expect(agentCore).toBeDefined();
    // Scoped to requests on behalf of this account — the confused-deputy case.
    expect(agentCore?.Condition).toEqual({
      StringEquals: { 'aws:SourceAccount': '123456789012' },
    });
  });

  it('outputs the identifiers an operator needs', () => {
    const template = synth();
    const outputs = Object.keys(template.toJSON().Outputs ?? {});

    expect(outputs).toEqual(
      expect.arrayContaining([
        'MemoryId',
        'MemoryArn',
        'MemoryKeyArn',
        'EventExpiryDays',
      ]),
    );
  });
});
