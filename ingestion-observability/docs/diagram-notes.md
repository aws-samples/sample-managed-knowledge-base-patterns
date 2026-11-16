# Architecture diagram notes

Staging notes for `docs/images/architecture.png`. The editable source is `docs/architecture.drawio`.

## Caption

The start path (steps 1–2) and the sweep path (step 4) claim each job once and send the Started event. The poller sends the Finished event (step 3).

## Icons

Every icon is a draw.io `mxgraph.aws4` shape from the current AWS Architecture Icons set, in the AWS category colors that draw.io's AWS4 palettes use:

| Shape | Label | Color |
| --- | --- | --- |
| `resourceIcon;resIcon=mxgraph.aws4.bedrock` | Amazon Bedrock | `#01A88D` (AI) |
| `mxgraph.aws4.documents` (General Resources, "Documents") | Data sources | `#232F3D` (General) |
| `mxgraph.aws4.cloudwatch_logs` | Amazon CloudWatch Logs | `#E7157B` (Management and governance) |
| `resourceIcon;resIcon=mxgraph.aws4.lambda` | AWS Lambda | `#ED7100` (Compute) |
| `resourceIcon;resIcon=mxgraph.aws4.dynamodb` | Amazon DynamoDB | `#C925D1` (Database) |
| `resourceIcon;resIcon=mxgraph.aws4.step_functions` | AWS Step Functions | `#E7157B` (Application integration) |
| `resourceIcon;resIcon=mxgraph.aws4.eventbridge` | Amazon EventBridge | `#E7157B` (Application integration) |
| `mxgraph.aws4.eventbridge_scheduler` | Amazon EventBridge Scheduler | `#E7157B` (Application integration) |
| `mxgraph.aws4.alarm` | Amazon CloudWatch | `#E7157B` (Management and governance) |
| `mxgraph.aws4.group` with `group_aws_cloud` | AWS Cloud | `#232F3E` |

The Data sources box stands for any managed data source connector, so it uses the generic Documents icon and names example connectors in text. The diagram has no third-party logos.

## Re-export

The PNG was exported with the draw.io desktop CLI (version 32.6.10, unzipped to a temporary folder, not installed):

```bash
/path/to/draw.io.app/Contents/MacOS/draw.io --export --format png --scale 1 --border 20 \
  --output docs/images/architecture.png docs/architecture.drawio
```

Run it from `ingestion-observability/`. On Linux, use the `drawio` binary from the AppImage or `.deb` with the same flags. Opening the `.drawio` file in draw.io and choosing **File > Export as > PNG** with a 20 px border gives the same result.

## Source of each component

| Diagram component | Source |
| --- | --- |
| Data sources ("Any managed data source connector, such as Amazon S3, Microsoft SharePoint, Confluence, or Salesforce") | The data sources of the tracked knowledge bases, of any [managed data source connector](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-connect-ds.html). The demo deploys an S3 data source (`DemoDataSource`, `ingestion-observability-stack.ts`). The pattern reads no connector-specific fields (README "Deploy"). |
| Knowledge bases 1..N (Amazon Bedrock) | `props.knowledgeBaseIds` and `DemoKnowledgeBase` |
| Ingestion log group `/aws/vendedlogs/bedrock/<name>` | `IngestionLogs` (`logs.LogGroup`), or `existingLogGroupName` |
| Start function (AWS Lambda) | `StartFunction` |
| Claim table (Amazon DynamoDB) | `Claims` (`dynamodb.Table`) |
| Poller (AWS Step Functions) | `Poller` (`sfn.StateMachine`, `createPoller`): `IncrementPollCount` → `Wait` → `GetIngestionJob` → `IsTerminal` |
| Alarm (Amazon CloudWatch) | `FailedExecutionsAlarm` on `stateMachine.metricFailed()` (`ExecutionsFailed`) |
| Schedule (Amazon EventBridge Scheduler) | `SweepSchedule` (`scheduler.Schedule`, every 15 minutes) |
| Sweep function (AWS Lambda) | `SweepFunction` |
| Event bus (Amazon EventBridge default event bus), source `custom.bedrock.kb-ingestion` | `eventBusName` (default `default`) and `eventSource` |
| Event capture (optional), `/ingestion-observability/<name>/events` | `CaptureEvents` (`events.Rule`) and `EventLogs`, when `captureEvents` is on |

## Source of each arrow

| Arrow | Path | Source |
| --- | --- | --- |
| Data sources → knowledge bases, "sync" | Other | The ingestion job reads the data source |
| Knowledge bases → log group, "log delivery" | Start | `CfnDeliverySource` (`APPLICATION_LOGS`), `CfnDelivery`, `CfnDeliveryDestination` |
| Log group → Start function, "subscription filter INGESTION_JOB_STARTED" | Start, step 1 | `StartedFilter` (`logs.SubscriptionFilter`, `LambdaDestination`) |
| Start function → claim table, "claim the job (once per job)" | Start, step 2 | `claim.py` `claim_and_announce` (`put_item` with a condition on the key `job#<kbId>#<dsId>#<jobId>` from `claim_key`); `dynamodb:PutItem` in `claimStatements` |
| Start function → poller, "start the poller (execution name = kbId-dsId-jobId)" | Start, step 2 | `claim.py` `execution_name`, `start_execution`; `states:StartExecution` |
| Start function → event bus, "PutEvents Knowledge Base Ingestion Job Started" | Start, step 2 | `claim.py` `put_events`; `STARTED_DETAIL_TYPE` |
| Poller → knowledge bases, "GetIngestionJob every 60–70 s until COMPLETE, FAILED, or STOPPED" | Finish, step 3 | `GetIngestionJob` task, `pollIntervalSeconds` 60 and `jitterSeconds` 10, `IsTerminal` |
| Poller → event bus, "PutEvents Knowledge Base Ingestion Job Finished" | Finish, step 3 | `EmitFinished` (`events:putEvents`), `FINISHED_DETAIL_TYPE` |
| Poller → alarm, "ExecutionsFailed metric" | Other | `FailedExecutionsAlarm` |
| Schedule → Sweep function, "invoke every 15 minutes" | Sweep, step 4 | `SweepSchedule` with `LambdaInvoke` |
| Sweep function → knowledge bases, "ListDataSources, ListIngestionJobs per tracked knowledge base" | Sweep, step 4 | `sweep.py` `list_data_sources`, `jobs_after`; `bedrock:ListDataSources`, `bedrock:ListIngestionJobs` |
| Sweep function → claim table, "claim missed jobs" | Sweep, step 4 | `sweep.py` calls `claim.claim_and_announce` |
| Sweep function → poller, "start the poller" | Sweep, step 4 | Same `claimStatements` (`states:StartExecution`) |
| Sweep function → event bus, "PutEvents Knowledge Base Ingestion Job Started (detectedBy RECONCILIATION)" | Sweep, step 4 | `claim_and_announce` with `detectedBy: RECONCILIATION` (README step 4) |
| Event bus → event capture, "capture rule (captureEvents)" | Other | `CaptureEvents` rule, pattern `{ source: [eventSource] }` |

Not drawn: the IAM roles, the function and poller log groups, the demo bucket's CDK helper functions, and the CloudWatch Logs resource policy for the capture rule. The diagram has no account IDs, tenant IDs, site URLs, or knowledge base IDs.
