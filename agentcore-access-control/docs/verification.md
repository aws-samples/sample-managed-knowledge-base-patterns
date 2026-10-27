# Verify the defenses

`scripts/verify_defenses.py` checks that each defense blocks the path it targets. Every sample document contains a unique code, so the script can tell from a response whether a document leaked:

| Document            | ACL            | Code              |
| ------------------- | -------------- | ----------------- |
| `dept-a-plan.txt`   | user-a         | `KINGFISHER-1101` |
| `dept-b-plan.txt`   | user-b         | `HAWKEAGLE-2202`  |
| `shared-notice.txt` | user-a, user-b | `FALCON-3303`     |

## Run against the default deployment

The script reads the stack outputs, signs in as both demo users with `ADMIN_USER_PASSWORD_AUTH`, and calls the gateway, the runtime, and the knowledge base. Your AWS credentials need `cloudformation:DescribeStacks`, `secretsmanager:GetSecretValue` on the demo password secret, `cognito-idp:AdminInitiateAuth` on the user pool, and `bedrock:Retrieve` (expected to be denied).

```bash
uv run python scripts/verify_defenses.py --region us-east-1
```

Add `--skip-agent` to skip the scenario that calls the LLM. The scenarios that need the bypass simulation are reported as `SKIP`.

| Scenario                                                              | Expected result                                                          | Blocked by            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------- |
| user-a and user-b call `kb___Retrieve`                                | Each user sees only the codes of documents in their ACL                  | ACL awareness         |
| user-a calls `kb___Retrieve` with user-b's `userContext`              | Only user-a's documents come back                                        | Request interceptor   |
| user-a calls `kb___AgenticRetrieveStream` with user-b's `userContext` | Only user-a's documents come back                                        | Request interceptor   |
| user-a asks the agent to search as user-b                             | The answer does not contain user-b's code                                | Request interceptor   |
| The deployer calls `Retrieve` with the AWS SDK                        | `AccessDeniedException` with an explicit deny in a resource-based policy | Resource-based policy |

## Run with the bypass simulation

The bypass simulation adds two gateways for the same knowledge base. They are intentionally weaker than the main gateway, so a default deployment does not create them. Both run as a simulation role whose identity-based policy allows retrieval but that the resource-based policy does not exempt.

```bash
cd infra
npx cdk deploy -c enableBypassSimulation=true
cd ..
uv run python scripts/verify_defenses.py --region us-east-1
```

| Scenario                                                              | Expected result                                                                             | Blocked by            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------- |
| Gateway without interceptor, user-b's `userContext`                   | The tool call is denied before it reaches the knowledge base                                | AgentCore Policy      |
| Gateway without interceptor, the caller's own `userContext`           | The policy allows the call, and the knowledge base denies it because the role is not exempt | Resource-based policy |
| Gateway without interceptor and policy engine, user-b's `userContext` | The knowledge base denies the search                                                        | Resource-based policy |

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
