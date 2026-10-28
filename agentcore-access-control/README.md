# Fine-grained access control for Amazon Bedrock Managed Knowledge Base MCP tools

This sample shows how to let an AI agent search a shared Amazon Bedrock Managed Knowledge Base through Amazon Bedrock AgentCore Gateway while each user can retrieve only the documents they are allowed to view. The LLM never decides who the user is. Trusted code derives the user from the verified access token, and independent layers stop requests when that code fails or is bypassed.

The sample is the companion code of the AWS blog post "Fine-grained access control for Bedrock Managed Knowledge Base as MCP tools". It deploys a web app, a Strands agent on AgentCore Runtime, and every defense described in the post.

![Architecture](docs/images/architecture.png)

## How it works

AnyCompany, a fictional company, shares one assistant and one knowledge base with all employees. The knowledge base holds the department A business plan (user-a only), the department B business plan (user-b only), and a notice for all departments (both users). Each document has a `.metadata.json` file with its access control list (`infra/data/documents`).

The Managed Knowledge Base connector target of AgentCore Gateway exposes `kb___Retrieve` and `kb___AgenticRetrieveStream` as MCP tools. ACL awareness needs `userContext` in the tool arguments, which the LLM could fill with another user's email. Four mechanisms keep every search scoped to the signed-in user:

|                   | Tool layer (AgentCore Gateway)                                                                         | Resource layer (Managed Knowledge Base)                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Primary defense   | Request interceptor overwrites `userContext` with the email claim of the verified access token         | ACL awareness returns only documents that the `userContext` user is allowed to view          |
| Secondary defense | AgentCore Policy (Cedar, ENFORCE) denies the call if `userContext.userId` differs from the email claim | Resource-based policy denies `Retrieve` to every principal except the gateway execution role |

The browser sends the user's Cognito access token to AgentCore Runtime, and the agent forwards the same token to the gateway. The agent code contains no access control logic.

## Repository structure

```
.
├── agent/                  Strands agent for AgentCore Runtime (Python, uv)
│   ├── src/main.py         Entry point of the direct code deployment package
│   ├── src/kb_agent/       Agent, token forwarding, event stream, history
│   └── tests/
├── frontend/               Web app (React, Vite, Cloudscape)
│   └── src/
├── infra/                  AWS CDK app (TypeScript)
│   ├── bin/app.ts
│   ├── lib/constructs/     Identity, knowledge base, gateway, runtime, hosting, bypass simulation
│   ├── functions/          Lambda functions: request interceptor, pre token generation, demo user password
│   ├── data/documents/     Sample documents and their ACL metadata
│   └── test/
├── scripts/
│   └── verify_defenses.py  Checks each defense against the path it targets
└── docs/
    ├── architecture.drawio Source of docs/images/architecture.png
    ├── images/
    └── verification.md
```

## Getting this sample

This sample lives in the [sample-managed-knowledge-base-patterns](https://github.com/aws-samples/sample-managed-knowledge-base-patterns) repository alongside other patterns that share no code with it. To get only this one, have Git fetch only this directory. With `--filter=blob:none`, the file contents of the other patterns are never downloaded.

```bash
# Clone the repository structure without any file contents
git clone --filter=blob:none --sparse \
  https://github.com/aws-samples/sample-managed-knowledge-base-patterns.git
cd sample-managed-knowledge-base-patterns

# Fetch only this sample
git sparse-checkout set agentcore-access-control

cd agentcore-access-control
```

Commands in this README run from the `agentcore-access-control` directory unless a step says to change into `infra/` or `frontend/`.

## Prerequisites

- An AWS account with permissions to create the resources in this sample, and credentials configured for the AWS CLI
- An AWS Region where Managed Knowledge Base, AgentCore Gateway, AgentCore Policy, and AgentCore Runtime are available. The sample was tested in US East (N. Virginia) (`us-east-1`).
- Access to the Amazon Bedrock model that the agent uses (default: the global cross-Region inference profile `global.anthropic.claude-sonnet-5-5`)
- Node.js 22 or later and npm
- [uv](https://docs.astral.sh/uv/). It installs Python 3.13 when needed.
- Optional: Docker. CDK uses it only when npm or uv is not available for asset bundling.

## Cost

The stack has no always-on compute, so the cost is mostly usage-based:

- Amazon Bedrock model inference for each agent turn, with the model set by `agentModelId`
- Managed Knowledge Base ingestion when the sample documents are indexed, and retrieval for each tool call
- AgentCore Runtime, AgentCore Gateway, and AgentCore Policy for each agent session, tool call, and authorization request
- AWS Lambda, Amazon CloudFront, Amazon S3, Amazon Cognito, and Amazon CloudWatch Logs, which are negligible for two demo users and three small documents

The standing cost is the knowledge base storage and the AWS Secrets Manager secret for the demo password, both billed for as long as the stack exists. See [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/) and [Amazon Bedrock AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/), and [clean up](#clean-up) when you finish.

## Deploy

```bash
make install
cd infra
npx cdk bootstrap   # once per account and Region
npx cdk deploy
```

`cdk deploy` builds the web app, packages the agent for arm64 with uv, uploads the sample documents, and starts an ingestion job. The stack prints these outputs, among others:

| Output                            | Description                                                     |
| --------------------------------- | --------------------------------------------------------------- |
| `WebAppUrl`                       | URL of the web app                                              |
| `DemoUserPasswordSecretArn`       | AWS Secrets Manager secret with the password of both demo users |
| `KnowledgeBaseId`, `DataSourceId` | Knowledge base and data source of the sample documents          |

Ingestion takes a few minutes. Check that the latest job is `COMPLETE`:

```bash
aws bedrock-agent list-ingestion-jobs \
  --knowledge-base-id <KnowledgeBaseId> --data-source-id <DataSourceId> \
  --query 'ingestionJobSummaries[0].status'
```

## Use the web app

1. Get the demo password:

   ```bash
   aws secretsmanager get-secret-value --secret-id <DemoUserPasswordSecretArn> \
     --query SecretString --output text
   ```

2. Open `WebAppUrl` and sign in as `user-a@example.com`.
3. Choose an example prompt. Each tool call shows the arguments that the agent generated and the documents that the gateway returned.
4. Try the prompt that asks the agent to search with `userContext.userId` set to `user-b@example.com`. The tool call shows the spoofed value, but only documents that user-a can view come back, because the interceptor overwrites it.
5. Sign out, sign in as `user-b@example.com`, and ask the same questions.

![The web app after user-a asked the agent to search as user-b](docs/images/web-app.png)

## Verify the defenses

```bash
uv run python scripts/verify_defenses.py
```

The script signs in as both demo users and checks the hardened gateway, the agent, and direct API calls. To also check AgentCore Policy and the resource-based policy against gateways that skip the tool layer defenses, redeploy with the opt-in bypass simulation. See [docs/verification.md](docs/verification.md).

## Configuration

Pass these context values to `cdk deploy` with `-c key=value`, or edit `infra/cdk.json`.

| Key                      | Default                              | Description                                                                                                  |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `agentModelId`           | `global.anthropic.claude-sonnet-5-5` | Amazon Bedrock model or inference profile ID for the agent                                                   |
| `enableBypassSimulation` | `false`                              | Deploy a gateway without the interceptor and a gateway without any tool layer control, for verification only |
| `allowLocalhostCallback` | `false`                              | Allow `http://localhost:5173` as a sign-in callback for local frontend development                           |

## Local frontend development

1. Deploy with `-c allowLocalhostCallback=true`.
2. Create `frontend/public/config.json` with values from the stack outputs. The file is ignored by Git.

   ```json
   {
     "region": "us-east-1",
     "userPoolId": "<UserPoolId>",
     "userPoolClientId": "<UserPoolClientId>",
     "cognitoDomain": "<CognitoDomainUrl>",
     "agentRuntimeArn": "<AgentRuntimeArn>"
   }
   ```

3. Run `npm run dev` in `frontend` and open `http://localhost:5173`.

## Development

```bash
make lint   # ruff, mypy --strict, oxlint, tsc
make test   # pytest, jest (including cdk-nag), vitest
```

`cdk synth` fails on any cdk-nag AwsSolutions finding that is not acknowledged. The acknowledgements in `infra/lib/nag-suppressions.ts` list what to harden before production use, such as AWS WAF, access logging, MFA, and a custom domain.

## Clean up

```bash
cd infra
npx cdk destroy
```

The stack deletes the knowledge base, the buckets and their objects, the user pool, and the demo password secret.

## Security

This sample is for demonstration. The demo users share one generated password, and the web app uses the default CloudFront domain. Review the cdk-nag acknowledgements and your organization's requirements before you adapt it. ACL awareness matches users by exact email, so your identity provider must keep emails unique, verified, and stable.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md).

## License

MIT-0. See [LICENSE](../LICENSE).
