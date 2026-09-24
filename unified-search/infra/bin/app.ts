#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AppStack } from '../lib/app-stack';
import { IdentityStack } from '../lib/identity-stack';
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack';
import { MemoryStack } from '../lib/memory-stack';
import { resolveKnowledgeBaseSelection } from '../lib/knowledge-base-selection';

const app = new cdk.App();

/**
 * Environment comes from the ambient CDK context, never from a literal.
 *
 * Account and region are resolved by the CLI from the caller's credentials, so the
 * same source deploys into any account and Region without editing.
 */
const stageName: string = app.node.tryGetContext('stage') ?? 'dev';
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const selection = resolveKnowledgeBaseSelection(app);

/**
 * In `sample` mode the knowledge base stack is instantiated and its ID flows into
 * the application stack. In `byo` mode the stack does not exist at all, so there
 * is no CDK resource that could modify the operator's knowledge base.
 */
let knowledgeBaseId: string;

/**
 * Conversation memory is optional even in `sample` mode.
 *
 * Chat works without it, single-turn, and the provider says so through
 * `capabilities.conversationMemory`. Opting in is explicit — `-c memory=true` — for
 * the same reason the knowledge base mode is explicit: AgentCore Memory is billed
 * separately, and a resource that starts costing money should not appear as a side
 * effect of a default.
 */
const memoryEnabled = String(app.node.tryGetContext('memory') ?? 'false') === 'true';
let memoryArn: string | undefined;

/**
 * A Cognito user pool is optional too, and for a different reason from memory.
 *
 * Memory is optional because it costs money. This is optional because most operators
 * already have an identity provider and would not want a second one — it exists so the
 * sample can be signed in to from a clean account, which is otherwise impossible since
 * every endpoint requires a verified token.
 *
 * Unlike memory it is deployable in **both** modes: a `byo` operator may well have a
 * real knowledge base and no appetite for wiring their corporate IdP into a sample.
 */
const identityEnabled =
  String(app.node.tryGetContext('identity') ?? 'false') === 'true';

if (identityEnabled) {
  const origins = String(
    app.node.tryGetContext('appOrigins') ?? 'http://localhost:5173',
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  new IdentityStack(app, `UnifiedSearch-${stageName}-Identity`, {
    stageName,
    appOrigins: origins,
    env,
    description: `Cognito user pool for unified-search (${stageName})`,
  });
}

if (selection.mode === 'sample') {
  const knowledgeBaseStack = new KnowledgeBaseStack(
    app,
    `UnifiedSearch-${stageName}-KnowledgeBase`,
    {
      stageName,
      env,
      description: `Sample managed knowledge base for unified-search (${stageName})`,
    },
  );
  knowledgeBaseId = knowledgeBaseStack.knowledgeBaseId;

  if (memoryEnabled) {
    const memoryStack = new MemoryStack(app, `UnifiedSearch-${stageName}-Memory`, {
      stageName,
      env,
      description: `Conversation memory for unified-search (${stageName})`,
    });
    memoryArn = memoryStack.memoryArn;
  }
} else {
  knowledgeBaseId = selection.knowledgeBaseId;

  if (memoryEnabled) {
    // Deliberately unsupported rather than silently ignored. In `byo` mode the
    // operator owns their infrastructure, so this stack does not provision an
    // encrypted, separately billed resource into their account from a context flag.
    // They can create one and pass MEMORY_ID directly.
    throw new Error(
      'kbMode=byo does not provision conversation memory. Create an AgentCore Memory ' +
        'resource yourself and set MEMORY_ID on the backend, or use -c kbMode=sample.',
    );
  }
}

new AppStack(app, `UnifiedSearch-${stageName}-App`, {
  stageName,
  knowledgeBaseId,
  ...(memoryArn === undefined ? {} : { memoryArn }),
  env,
  description: `Unified Search on Bedrock Managed Knowledge Base (${stageName})`,
});

cdk.Tags.of(app).add('Project', 'unified-search');
cdk.Tags.of(app).add('Stage', stageName);
cdk.Tags.of(app).add('KnowledgeBaseMode', selection.mode);

/**
 * cdk-nag, registered at the app level so every stack is checked without anyone
 * remembering to opt in.
 *
 * cdk-nag v3 participates in CDK's native policy validation framework rather
 * than running as an Aspect, so violations fail `cdk synth` outright and are
 * written to `policy-validation-report.json`. That makes this a build control
 * rather than an advisory report. Rules are acknowledged individually with
 * `Validations.of(construct).acknowledge({ id, reason })` — always with a
 * written reason.
 */
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

app.synth();
