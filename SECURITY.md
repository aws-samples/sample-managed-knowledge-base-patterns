# Security Policy

## Reporting a vulnerability

If you discover a potential security issue in any pattern in this repository, we
ask that you notify AWS/Amazon Security via our
[vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/)
or directly via email to aws-security@amazon.com.

Please do **not** create a public issue for a security vulnerability.

When reporting, name the pattern directory the issue is in. Scrub identifiers
first: AWS account IDs, knowledge base IDs, tenant IDs, ARNs, and document
excerpts routinely appear in the diagnostic output these patterns produce.

## Scope

These are samples intended to be read and adapted, not supported products.
Please still report security issues through the process above, because a defect
copied out of a sample propagates into the systems that copied it.

## Per-pattern security properties

A pattern that depends on a specific security property documents it in its own
`SECURITY.md`, alongside the code paths that must not be changed without
understanding it. Read that file before modifying a pattern's authentication or
authorization behavior.

- [agentcore-access-control](agentcore-access-control/SECURITY.md): why
  `userContext` must come from the verified access token and never from tool
  arguments, and which layer checks each step on the way to the knowledge base.
- [agentcore-memory-multiuser](agentcore-memory-multiuser/SECURITY.md): why
  `userContext.userId`, `actorId`, and the memory namespace must come from the
  verified ID token, and what the per-user session tag on the application role
  does and does not protect against.
- [amazon-quick-acl](amazon-quick-acl/SECURITY.md): why the embed harness must
  never accept a user identity from the request, and how Quick's identity
  reaches Bedrock's ACL filtering.
- [retrieval-instructions](retrieval-instructions/SECURITY.md): why the
  metadata filter must come from the authenticated tenant on the server, why a
  retrieval instruction is not an isolation boundary, and what the tenant role
  tag conditions do and do not cover.
- [tabular-search](tabular-search/SECURITY.md): who can read the sample
  files, what `bedrock:GetDocumentContent` in the caller policy allows, and
  how the knowledge base role stays in step with the policies in `iam/`.
- [unified-search](unified-search/SECURITY.md): why
  `userContext.userId` must come from a verified token, and how to confirm
  what a given user is permitted to read.

## Secret scanning

Every change is scanned for committed secrets across the whole repository, in
both the working tree and the full history, using the configuration in
`.gitleaks.toml`. A finding is pinned to the commit that introduced it and
outlives the line that caused it, so treat a scan failure as something to fix
before merging rather than after.
