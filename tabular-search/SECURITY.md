# Security Policy

## Reporting a vulnerability

If you discover a potential security issue in this sample, we ask that you notify AWS/Amazon Security via our [vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/) or directly via email to aws-security@amazon.com.

Please do not create a public GitHub issue for a security vulnerability.

Remove identifiers from anything you share: AWS account IDs, knowledge base IDs, bucket names, request IDs, and answer text appear in this sample's output.

## The security property this sample depends on

Read this before changing the policies in `iam/`, or the bucket, role, or data source in `infra/lib/tabular-search-stack.ts`.

The data source has document-level access control turned off (`aclEnabled: false`), so the knowledge base returns the same files to every caller. IAM decides who can read them: any identity that can call `bedrock:Retrieve` or `bedrock:AgenticRetrieveStream` on the knowledge base. The consequences:

- Every caller can read every file in the knowledge base, and every answer can draw on every file. To give different audiences different files, use a separate knowledge base for each audience, or a pattern in this repository that applies document-level ACLs.
- The caller policy, `iam/caller-policy.json`, grants `bedrock:GetDocumentContent`. Tabular search uses it, because the agent reads the original table file with the caller's credentials. The same permission lets the caller read the original files directly, in addition to passages. The policy covers every knowledge base in the account and Region (`knowledge-base/*`). Before you reuse it, scope `Resource` to the knowledge bases each identity needs.
- The knowledge base role trusts only `bedrock.amazonaws.com`, with `aws:SourceAccount` and `aws:SourceArn` conditions that limit it to knowledge bases in your account. The conditions keep knowledge bases in other accounts from using the role (the confused deputy problem).
- The role can only list the bucket and read its objects. It reads only this bucket and has no write access.
- The bucket blocks public access, turns off ACLs, and requires TLS, so the files are reachable only through IAM, and only over TLS.

## Failure behavior worth knowing

Access fails closed. An identity without the caller policy receives `AccessDeniedException` rather than results. The data source skips files larger than its size filter, so those files never become searchable.

Model-written code runs in an isolated sandbox with no network access, and the agent gets back only what the code prints. To keep cell values out of the trace, the trace doesn't include the generated code or its output. It shows which files the code read.

`cdk synth` fails on any cdk-nag AwsSolutions finding that is not acknowledged in `infra/lib/nag-suppressions.ts`. Wildcard permissions are acknowledged by exact finding, so synth reports any wildcard added later. Before production use, turn on S3 server access logging for the bucket (AwsSolutions-S1).

## Architectural boundary

The knowledge base role's permissions are written in one place, the two policy files in `iam/`. The stack deploys them as written, and the infrastructure tests check that the deployed role matches them and has no other policy attached. Keep it that way: a grant added in stack code would sit outside the policies the README documents, and a second source of permissions doubles what has to be reviewed.

The knowledge base role is used only by Amazon Bedrock to read the bucket during ingestion. Questions run with the caller's own credentials, so the caller policy, not the role, decides who can ask.

## Reporting scope

This sample is for learning and adaptation. Report security issues through the process above, so that fixes reach everyone who builds on it.
