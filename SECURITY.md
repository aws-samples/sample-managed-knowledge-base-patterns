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

- [unified-search](unified-search/SECURITY.md): why
  `userContext.userId` must come from a verified token, and how to confirm
  what a given user is permitted to read.

## Secret scanning

Every change is scanned for committed secrets across the whole repository, in
both the working tree and the full history, using the configuration in
`.gitleaks.toml`. A finding is pinned to the commit that introduced it and
outlives the line that caused it, so treat a scan failure as something to fix
before merging rather than after.
