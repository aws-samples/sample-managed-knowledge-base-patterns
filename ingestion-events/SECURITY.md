# Security Policy

## Reporting a vulnerability

If you discover a potential security issue in this sample, we ask that you notify AWS/Amazon Security via our [vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/) or directly via email to aws-security@amazon.com.

Please do not create a public GitHub issue for a security vulnerability.

Remove identifiers from anything you share. This sample's events and logs include AWS account IDs; knowledge base, data source, and ingestion job IDs; ARNs; `failureReasons` text; and document titles and URIs.

## The security property this sample depends on

Read this before changing the IAM statements in `infra/lib/ingestion-events.ts`, the log groups, the subscription filter, or the event capture rule and its resource policy in `infra/lib/ingestion-events-stack.ts`.

The pattern reads ingestion job metadata and republishes it as events. None of its roles can retrieve from a knowledge base or read a document. The only Amazon Bedrock actions they have are `bedrock:ListDataSources`, `bedrock:ListIngestionJobs`, and `bedrock:GetIngestionJob`, on the tracked knowledge bases. The data that the pattern exposes is in its log groups and on the event bus, so the main question is who can read them:

- **The ingestion log group holds document titles and URIs.** In the default mode the stack creates `/aws/vendedlogs/bedrock/<name>`, and every tracked knowledge base delivers its `APPLICATION_LOGS` there. The knowledge base writes a [document-level record](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-observability.html) for each document, with fields such as `document_id` and `source_uri` (the S3 bucket and key, or the SharePoint site and path). Records can also include the document title and, for SharePoint list items, author identities in their metadata. Any identity that can read the log group reads these for every knowledge base that delivers to it. The group keeps them for 30 days.
- **In existing-log-group mode, the group isn't the stack's.** It can hold records from knowledge bases you don't list in `knowledgeBaseIds`, and its other readers, subscription filters, and retention are whatever they already were. The stack adds only its subscription filter.
- **The subscription filter passes only start records.** Its pattern is `{ $.event.ingestion_job_status = "INGESTION_JOB_STARTED" }`, so document records aren't sent to the Start function. A start record contains the knowledge base ARN, the data source ID, and the job ID. The Start function ignores records of knowledge bases it doesn't track and logs their knowledge base ID and job ID as `untracked knowledge base`. The function's invoke permission for `logs.amazonaws.com` is limited to the ingestion log group's ARN, without an `aws:SourceAccount` condition.
- **Events go to the `default` bus unless you set `eventBusName`.** The Started event includes IDs, the knowledge base ARN, and timestamps. The Finished event adds the job statistics and `failureReasons`, which can name IAM roles and buckets. An `UNKNOWN_ERROR` event adds the Step Functions error name and up to 2,000 characters of its cause. Every identity that can create rules on the bus can read these events.
- **The capture log group stores every event.** With `captureEvents` on (the default), a rule matching the pattern's `source` writes every event to `/ingestion-events/<name>/events`, which keeps events for 30 days. Anyone who can read that group can read the `failureReasons`. A CloudWatch Logs resource policy lets `events.amazonaws.com` and `delivery.logs.amazonaws.com` call `logs:CreateLogStream` and `logs:PutLogEvents` on that group only, without an `aws:SourceAccount` condition. Set `captureEvents=false` to deploy neither.
- **Each role allows only what its code calls:**
  - Start function: `events:PutEvents` on the bus; `dynamodb:GetItem`, `PutItem`, `UpdateItem`, and `DeleteItem` on the claim table; `states:StartExecution` on the poller.
  - Sweep function: the same, plus `bedrock:ListDataSources` and `bedrock:ListIngestionJobs` on the tracked knowledge bases.
  - Both functions also have the AWS managed policy `AWSLambdaBasicExecutionRole`, which only grants writing CloudWatch logs.
  - Poller (the state machine): `bedrock:GetIngestionJob` on the tracked knowledge bases and `events:PutEvents` on the bus, plus the CloudWatch Logs delivery actions AWS CDK adds for state machine logging, on `*`. Those actions don't support resource-level permissions.
  - Scheduler: `lambda:InvokeFunction` on the Sweep function and its versions and aliases (`<arn>:*`). The function has none.
  - Demo knowledge base role: trusts only `bedrock.amazonaws.com`, with `aws:SourceAccount` and `aws:SourceArn` conditions that limit it to knowledge bases in your account. It can only list the demo bucket and read its objects, with an `aws:ResourceAccount` condition.
- **The claim table controls which jobs are announced.** It has one item per job and one watermark timestamp per data source. Each job item is keyed by the knowledge base, data source, and job IDs. It has a state of `CLAIMED` or `ANNOUNCED`, the claim time, `detectedBy`, the knowledge base and data source IDs, and a 7-day TTL. It holds no document content. Only the two functions are granted access to it. An `ANNOUNCED` item written by anything else for a job's key means that job gets no Started event and no poller.
- **The demo bucket** blocks public access, turns off ACLs, uses SSE-S3 encryption, and requires TLS. Its data source has document-level access control turned off (`aclEnabled: false`), and the files in `data/docs/` are fictitious runbooks.

## Failure behavior worth knowing

Jobs of knowledge bases outside `knowledgeBaseIds` don't get a poller. The Start function skips their start records, and the Sweep function lists only the tracked knowledge bases. If the poller's role doesn't cover a knowledge base it polls, `GetIngestionJob` returns `BedrockAgent.AccessDeniedException`, and the poller sends a Finished event with `UNKNOWN_ERROR` and its execution fails.

Set `eventBusName` to an existing bus in the stack's account and Region. A PutEvents call that reports a failed entry fails the Start or Sweep function's claim, which releases the claim so a later run can try again. In the poller, it fails the execution with `EventBridge.FailedEntry` after 3 retries.

Failed poller executions raise the `ExecutionsFailed` alarm, which has no actions. Add one to be notified.

The poller logs to `/aws/vendedlogs/states/<name>-poller` without execution data, so its log has no job input, `GetIngestionJob` output, or `failureReasons`. The Start and Sweep functions log one JSON line per outcome to their own log groups. Each line has the job, knowledge base, and data source IDs, the Started event detail, and the text of any error. Every log group the stack creates keeps events for 30 days and is deleted with the stack.

`cdk synth` fails on any cdk-nag AwsSolutions finding that is not acknowledged in `infra/lib/nag-suppressions.ts`. Wildcard permissions are acknowledged by exact finding, so synth reports any wildcard added later. Before production use, replace `AWSLambdaBasicExecutionRole` with a policy scoped to each function's own log group. If you trace requests end to end, turn on AWS X-Ray tracing on the state machine (AwsSolutions-SF2). For any bucket that holds real documents, turn on S3 server access logging (AwsSolutions-S1).

## Architectural boundary

The permissions of the Start function, the Sweep function, and the poller are written in one place, the `IngestionEvents` construct in `infra/lib/ingestion-events.ts`. The knowledge base ARNs in their policies and the `TRACKED_KNOWLEDGE_BASE_IDS` the functions check come from the same `knowledgeBaseIds` list. Keep it that way. A grant or a tracked ID added elsewhere would let the functions announce jobs that the poller can't read. It could also let the roles read knowledge bases that the deployment doesn't track.

## Reporting scope

This sample is for learning and adaptation. Report security issues through the process above, so that everyone who builds on it gets the fixes.
