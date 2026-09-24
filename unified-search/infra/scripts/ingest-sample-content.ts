#!/usr/bin/env tsx
/**
 * Starts an ingestion job and waits for it to finish, reporting what it indexed.
 *
 * The stack also outputs a `start-ingestion-job` command, but running it by hand
 * means polling `get-ingestion-job` until it reaches `COMPLETE`. Nothing is
 * searchable until ingestion finishes, so running the ACL suite before then returns
 * empty results. This script starts the job and waits for it.
 *
 * Ingestion is not started by `cdk deploy`, because it costs money and a
 * sample should not begin incurring charges as a side effect of deploying. It is
 * started here, explicitly.
 *
 * ## Why the statistics are checked and not just printed
 *
 * On an ACL-enabled data source, a document with no matching ACL entry is **not
 * ingested at all**. So a job can reach `COMPLETE` having indexed nothing, and the
 * knowledge base then returns zero results to every user, which from the outside
 * looks the same as ACL filtering denying someone or a query that matched nothing.
 *
 * `N scanned / 0 indexed` can mean that the ACL file is missing or its `keyPrefix`
 * values do not match the uploaded keys. It is **also** the expected result of
 * re-ingesting unchanged content, so this script reports both possibilities — see
 * {@link report}. `make test-acl` tells them apart by retrieving as known
 * identities.
 *
 *   npm run ingest:sample -- --stage dev
 */
import {
  BedrockAgentClient,
  GetIngestionJobCommand,
  ListDataSourcesCommand,
  StartIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';

import type { IngestionStatistics } from '../lib/ingestion-outcome';
import { classifyIngestion, NOTHING_NEW_EXPLANATION } from '../lib/ingestion-outcome';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

const REGION = process.env.AWS_REGION ?? 'us-east-1';
/** Terminal states, from the service's ingestion job status enum. */
const DONE = new Set(['COMPLETE', 'FAILED', 'STOPPED']);
const POLL_INTERVAL_MS = 10_000;
const TIMEOUT_MS = 30 * 60 * 1000;

const cloudformation = new CloudFormationClient({ region: REGION });
const bedrock = new BedrockAgentClient({ region: REGION });

async function stackOutput(stackName: string, key: string): Promise<string> {
  const response = await cloudformation.send(
    new DescribeStacksCommand({ StackName: stackName }),
  );
  const outputs = response.Stacks?.[0]?.Outputs ?? [];
  const value = outputs.find((output) => output.OutputKey === key)?.OutputValue;

  if (value === undefined || value === '') {
    throw new Error(
      `Stack ${stackName} has no ${key} output. Deploy in sample mode first:\n` +
        '  npm run deploy:sample',
    );
  }
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const stage = arg('stage', 'dev');
  const stackName = arg('stack', `UnifiedSearch-${stage}-KnowledgeBase`);

  const knowledgeBaseId = await stackOutput(stackName, 'KnowledgeBaseId');

  // Resolved from the knowledge base rather than taken from a second stack output,
  // so this cannot drift if the data source is ever replaced.
  const dataSources = await bedrock.send(
    new ListDataSourcesCommand({ knowledgeBaseId }),
  );
  const dataSourceId = dataSources.dataSourceSummaries?.[0]?.dataSourceId;
  if (dataSourceId === undefined) {
    throw new Error(`Knowledge base ${knowledgeBaseId} has no data sources.`);
  }

  process.stdout.write(`Ingesting ${knowledgeBaseId} / ${dataSourceId} in ${REGION}\n`);

  const started = await bedrock.send(
    new StartIngestionJobCommand({
      knowledgeBaseId,
      dataSourceId,
      description: 'Seeded sample content',
    }),
  );
  const ingestionJobId = started.ingestionJob?.ingestionJobId;
  if (ingestionJobId === undefined) {
    throw new Error('StartIngestionJob returned no job ID.');
  }

  process.stdout.write(`  job ${ingestionJobId}\n`);

  const deadline = Date.now() + TIMEOUT_MS;
  let status = started.ingestionJob?.status ?? 'STARTING';

  while (!DONE.has(status)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Ingestion job ${ingestionJobId} did not finish within 30 minutes ` +
          `(last status ${status}). It may still be running; check with ` +
          `aws bedrock-agent get-ingestion-job --knowledge-base-id ${knowledgeBaseId} ` +
          `--data-source-id ${dataSourceId} --ingestion-job-id ${ingestionJobId}`,
      );
    }

    await sleep(POLL_INTERVAL_MS);

    const current = await bedrock.send(
      new GetIngestionJobCommand({ knowledgeBaseId, dataSourceId, ingestionJobId }),
    );
    const next = current.ingestionJob?.status ?? status;
    if (next !== status) process.stdout.write(`  ${next}\n`);
    status = next;

    if (DONE.has(status)) {
      report(
        status,
        current.ingestionJob?.statistics,
        current.ingestionJob?.failureReasons,
      );
      return;
    }
  }

  report(
    status,
    started.ingestionJob?.statistics,
    started.ingestionJob?.failureReasons,
  );
}

function report(
  status: string,
  statistics: IngestionStatistics | undefined,
  failureReasons: readonly string[] | undefined,
): void {
  const scanned = statistics?.numberOfDocumentsScanned ?? 0;
  const indexed =
    (statistics?.numberOfNewDocumentsIndexed ?? 0) +
    (statistics?.numberOfModifiedDocumentsIndexed ?? 0);
  const failed = statistics?.numberOfDocumentsFailed ?? 0;

  process.stdout.write(
    `\n${status}: ${String(scanned)} scanned / ${String(indexed)} indexed / ` +
      `${String(failed)} failed\n`,
  );

  if (failureReasons !== undefined && failureReasons.length > 0) {
    for (const reason of failureReasons) process.stderr.write(`  ${reason}\n`);
  }

  const verdict = classifyIngestion(status, statistics);

  switch (verdict.kind) {
    case 'failed':
      throw new Error(verdict.reason);
    case 'nothing-new':
      process.stdout.write(
        `\nNote: ${String(verdict.scanned)} document(s) scanned, none newly indexed.\n\n` +
          `${NOTHING_NEW_EXPLANATION}\n`,
      );
      return;
    case 'indexed':
      process.stdout.write(
        '\nIndexed. Documents are now searchable, and the ACL suite can run:\n' +
          '  make test-acl\n',
      );
      return;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
