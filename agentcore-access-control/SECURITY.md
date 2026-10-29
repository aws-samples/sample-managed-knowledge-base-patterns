# Security Policy

## Reporting a vulnerability

If you discover a potential security issue in this sample, we ask that you notify AWS/Amazon Security via our [vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/) or directly via email to aws-security@amazon.com.

Please do not create a public GitHub issue for a security vulnerability.

## The security property this sample depends on

Read this before changing anything under `infra/functions/interceptor/` or `infra/functions/pre_token_generation/`, the gateway in `infra/lib/constructs/kb-mcp-gateway.ts`, the Cedar policy in `infra/lib/constructs/cedar.ts`, or the resource-based policy in `infra/lib/constructs/knowledge-base.ts`.

Amazon Bedrock Managed Knowledge Base provides ACL-aware filtering for the identity in `userContext`. Per the [AWS documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-acl.html), ACL awareness is filtering, not authorization: the application authenticates the user and passes verified identity context, and Bedrock applies document permissions for that identity. The AgentCore Gateway connector exposes `userContext` as an ordinary tool argument, which the LLM could fill with anyone's email, so what a user can read depends on the value that reaches the knowledge base. The consequences:

- `userContext` is derived only from the `email` claim of the verified access token, never from tool arguments. The REQUEST interceptor overwrites `arguments.userContext` of every `tools/call`. The agent and the LLM never set it, and the agent forwards the user's token unchanged.
- The interceptor decodes the token without checking the signature, because the gateway JWT authorizer verified it first. Do not attach the interceptor to an endpoint without that authorizer.
- The interceptor runs before the Cedar policy, and the policy checks the interceptor's output against the `email` claim. Reordering them removes the second layer, because nothing would then verify the value that the interceptor writes.
- The knowledge base resource-based policy denies `bedrock:Retrieve` and `bedrock:GetDocumentContent` to every principal except one role, the execution role of the hardened gateway. Anything that shares or assumes that role bypasses the policy, which is why the bypass simulation gateways use a separate role. `bedrock:AgenticRetrieveStream` cannot be named in the policy, but its internal search is authorized as `bedrock:Retrieve`, so the same deny applies.
- `allowedAudience` must stay unset on the JWT authorizers of the gateway and the runtime. Cognito access tokens carry `client_id`, not `aud`, so setting it rejects every token. `allowedClients` checks the client instead.
- Only access tokens are accepted. Cognito ID tokens carry `email` whether or not it is verified, while the pre token generation trigger adds the claim to access tokens only for verified emails.
- The `email` claim is the join key against the document ACLs, so the identity provider must keep it unique, verified, and stable. The user pool makes `email` immutable and disables self sign-up for this reason. If an email is reassigned to another person, that person inherits the previous user's access.

## Failure behavior worth knowing

Every layer fails closed. The interceptor rejects a `tools/call` without a verified email claim with a JSON-RPC error, and it rejects any request body that is not a single JSON object, such as a JSON-RPC batch, because the overwrite would not see a `tools/call` inside it. AgentCore Policy permits a call only when `userContext.userId` is present and equals the claim. ACL-aware retrieval omits a document when ACL evaluation fails or its ACL metadata is missing. The resource-based policy is an explicit deny, which overrides identity-based allows in the same account.

A misconfiguration therefore presents as fewer results or an access denied error rather than as a leak, so confirm each layer instead of inferring it from the absence of errors. `scripts/verify_defenses.py` checks each defense against the path it targets. See [docs/verification.md](docs/verification.md).

## Architectural boundary

`userContext` is written in one place, `infra/functions/interceptor/interceptor.py`. Keep it there: a value set by the agent, a tool description, or the prompt is not a defense, and a second code path that sets it doubles what has to be reviewed.

The bypass simulation gateways skip the tool layer defenses on purpose, to exercise the secondary defenses. They are off by default and must not serve real users.

The demo users share one generated password in AWS Secrets Manager. A custom resource function reads the secret and sets the password, so only the secret ARN is a resource property. Do not pass a secret value as a custom resource property: CloudFormation shows the properties in the stack events, and the provider logs the event it receives.

## Reporting scope

This is a sample intended to be read and adapted, not a supported product. Please still report security issues through the process above, because a defect copied out of a sample propagates.
