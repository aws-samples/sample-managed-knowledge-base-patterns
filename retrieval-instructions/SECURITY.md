# Security Policy

## Reporting a Vulnerability

If you discover a potential security issue in this project, we ask that you
notify AWS/Amazon Security via our
[vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/)
or directly via email to aws-security@amazon.com.

Please do **not** create a public GitHub issue for security vulnerabilities.

## The security property this sample depends on

Read this before changing `python/src/ri_sample/filters.py`, `tenancy.py`, `ask.py`, or
`cli.py`, their TypeScript counterparts `typescript/src/filters.ts`, `tenancy.ts`,
`ask.ts`, and `cli.ts`, or `infra/lib/constructs/tenant-roles.ts` and
`platform-admin-role.ts`.

- **The filter must be built on the server from the authenticated tenant.** Amazon
  Bedrock applies whatever metadata filter the request sends, and IAM has no condition
  key for it. A caller who can choose the filter can read any tenant's documents, so the
  filter must never come from the question or other user input. In the sample, the
  filter is chosen in `tenancy.py` (`tenancy.ts`): `tenant_request()`
  (`tenantRequest()`) gets it from `tenant_scope()` for the tenant key, and
  `south_retriever_filters()` gives the two per-knowledge-base filters of the multi-KB
  request. Requests are built only by `build_request()` and `ask_as_tenant()`
  (`buildRequest()`, `askAsTenant()`). Both accept a filter only as the `TenantFilter`
  type that `tenancy` creates, so `mypy --strict` and `tsc` reject a plain dictionary
  passed to them as a filter. `send_request()` (`sendRequest()`) sends a request that
  `build_request()` returned; keep it that way. Keep the filter builders out of every
  other module. The three requests that send no filter (`baseline` without a tenant,
  the first `isolation` call, and `multi-kb --no-filters`) exist to show what the
  filter prevents, and say so in their output.
- **A retrieval instruction isn't an isolation boundary.** It changes how answers are
  written. It isn't an authorization or data-isolation boundary: without a filter, a
  tenant's request can retrieve other tenants' documents and the restricted notes.
  Answer policies are best effort.
- **A filter can't remove a value from a shared document the tenant is entitled to.**
  A global policy that lists every region's terms reaches every region tenant.

## What the IAM tag conditions cover

The optional tenant roles use tag conditions on retrieval instructions:

- **Which instruction a tenant role can apply.** The applier has
  `bedrock:GetRetrievalInstruction` only on instructions tagged with its tenant, and
  applying an instruction requires it.
- **Which instructions a tenant admin can create, change, and tag.** Its `TagResource`
  statement requires its tenant in both `aws:RequestTag/tenant` and
  `aws:ResourceTag/tenant`, which stops it from retagging another tenant's instruction
  into its own scope.
- **The platform admin's scope**, which is the `app=retrieval-instructions-sample` tag.
  A tenant admin can't take its own instruction out of that scope: the
  `KeepSampleAppTag` deny refuses a `TagResource` that sets `app` to another value, and
  no role has `bedrock:UntagResource`.

`verify-abac` checks the apply, retag, and `app` denials and the platform admin's read.
It doesn't check the tenant admin's create path (its `aws:RequestTag/app` condition),
because a create would use quota. That path follows the structure described in
[DESIGN.md](DESIGN.md#iam).

What the conditions don't cover:

- Retrieval. It's authorized separately as `bedrock:Retrieve`, which each role has only
  on its own knowledge bases.
- The filter. No IAM condition sees it.
- Requests that apply no instruction.
- `ListRetrievalInstructions`, which can't be scoped by tag, so any role with it lists
  every instruction name in the account and Region. Instruction names must not hold
  sensitive information.

## Trust

The tenant roles and the platform admin role exist only when the stack is deployed with
`trustedPrincipalArn`, and they trust only that principal. The variant with one role and
a tenant session tag is untested: the sample uses a role per tenant.

`verify-abac` holds the assumed-role credentials in memory only. Neither program writes
credentials anywhere: the only file they write is `sample-state.json`, which holds
instruction IDs, ARNs, the account ID, and release pins, and is gitignored.

## Encryption

`customerEncryptionKeyArn` is set when an instruction is created and can't be changed
later. The sample documents it and doesn't use a key.

## Failure behavior worth knowing

- **A wrong filter fails silently.** It returns more or fewer documents without an
  error. Run `isolation` after any change to the filters or the metadata.
- **A pin to a missing version fails at send**, with a `ValidationException` and no
  answer.

## Reporting scope

This is a sample intended to be read and adapted, not a supported product.
Please still report security issues through the process above, because a defect
copied out of a sample propagates.
