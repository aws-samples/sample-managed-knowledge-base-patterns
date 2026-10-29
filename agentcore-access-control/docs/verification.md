# Verify the defenses

`scripts/verify_defenses.py` checks that each defense blocks the path it targets. Every sample document contains a unique code, so the script can tell from a response whether a document leaked:

| Document            | ACL            | Code              |
| ------------------- | -------------- | ----------------- |
| `dept-a-plan.txt`   | user-a         | `KINGFISHER-1101` |
| `dept-b-plan.txt`   | user-b         | `HAWKEAGLE-2202`  |
| `shared-notice.txt` | user-a, user-b | `FALCON-3303`     |

## Run against the default deployment

The script reads the stack outputs, signs in as both demo users with `ADMIN_USER_PASSWORD_AUTH`, and calls the gateway, the runtime, and the knowledge base. Your AWS credentials need `cloudformation:DescribeStacks`, `secretsmanager:GetSecretValue` on the demo password secret, `cognito-idp:AdminInitiateAuth` on the user pool, and `bedrock:Retrieve` and `bedrock:AgenticRetrieveStream` (expected to be denied).

```bash
uv run python scripts/verify_defenses.py --region us-east-1
```

Add `--skip-agent` to skip the scenario that calls the LLM. The scenarios that need the bypass simulation are reported as `SKIP`.

The agent scenario proves something only when the model actually sends user-b's `userContext` and the gateway answers that call. A turn in which the model refuses, fails, or answers without that call never reaches the interceptor, so the script runs up to three turns and reports `SKIP` (inconclusive) when none of them did. The gateway scenarios check the interceptor deterministically on every run.

| Scenario                                                              | Expected result                                                                                | Blocked by            |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------- |
| user-a and user-b call `kb___Retrieve`                                | Each user sees only the codes of documents in their ACL                                        | ACL awareness         |
| user-a calls `kb___Retrieve` with user-b's `userContext`              | Only user-a's documents come back                                                              | Request interceptor   |
| user-a calls `kb___AgenticRetrieveStream` with user-b's `userContext` | Only user-a's documents come back                                                              | Request interceptor   |
| user-a asks the agent to search as user-b                             | The agent sends user-b's `userContext`, and the answer does not contain user-b's code          | Request interceptor   |
| The deployer calls `Retrieve` with the AWS SDK                        | `AccessDeniedException` with an explicit deny in a resource-based policy                       | Resource-based policy |
| The deployer calls `AgenticRetrieveStream` with the AWS SDK           | The stream fails because the resource-based policy denies its internal `bedrock:Retrieve` call | Resource-based policy |

## Run with the bypass simulation

The bypass simulation adds two gateways for the same knowledge base. They are intentionally weaker than the main gateway, so a default deployment does not create them. Both run as a simulation role whose identity-based policy allows retrieval but that the resource-based policy does not exempt.

```bash
cd infra
npx cdk deploy -c enableBypassSimulation=true
cd ..
uv run python scripts/verify_defenses.py --region us-east-1
```

| Scenario                                                                                                | Expected result                                                                                                                                                                                                            | Blocked by            |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Gateway without interceptor, user-b's `userContext`                                                     | The tool call is denied before it reaches the knowledge base                                                                                                                                                               | AgentCore Policy      |
| Gateway without interceptor, the caller's own `userContext`                                             | The policy allows the call, and the knowledge base denies it because the role is not exempt                                                                                                                                | Resource-based policy |
| Gateway without interceptor and policy engine, `kb___Retrieve` with user-b's `userContext`              | The knowledge base denies the search                                                                                                                                                                                       | Resource-based policy |
| Gateway without interceptor and policy engine, `kb___AgenticRetrieveStream` with user-b's `userContext` | The knowledge base denies the internal `bedrock:Retrieve` call of the agentic search. The gateway reports it as `InternalServerException`, so the script confirms that the same call through the hardened gateway succeeds | Resource-based policy |

Redeploy without the context value afterwards to remove the simulation gateways:

```bash
cd infra
npx cdk deploy
```

## Inspect the interceptor

The interceptor logs, without emails or tokens, whether the client supplied `userContext` and whether the interceptor replaced a different value. After the spoofing scenarios, its log group in Amazon CloudWatch Logs contains entries such as:

```json
{
  "tool": "kb___Retrieve",
  "userContextSupplied": true,
  "userContextReplaced": true
}
```
