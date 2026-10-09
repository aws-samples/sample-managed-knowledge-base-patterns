# Security Policy

## Reporting a Vulnerability

If you discover a potential security issue in this project, we ask that you
notify AWS/Amazon Security via our
[vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/)
or directly via email to aws-security@amazon.com.

Please do **not** create a public GitHub issue for security vulnerabilities.

## The security property this sample depends on

Read this before changing anything under `webapp/server/`.

Amazon Bedrock Managed Knowledge Base applies **ACL-aware filtering** for the
identity the caller supplies. Per the
[AWS documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-acl.html),
authenticating end users is the caller's responsibility: the caller passes an
identity, and Bedrock filters retrieval results against the ACLs for that
identity.

In this sample, Amazon Quick is the caller. Quick authenticates the user and
forwards their identity to Bedrock, which is why the application contains no
authentication code. That holds only while the Quick session belongs to the
person using it. The consequences:

- **Whoever chooses `UserArn` chooses what gets retrieved.**
  `GenerateEmbedUrlForRegisteredUser` mints a session for whichever Quick user
  the caller names, and Quick forwards that user's identity to Bedrock. An
  endpoint that accepts a user identity from its caller is a read-anything
  privilege escalation against every ACL-enabled data source.
- **The harness is a local development tool.** It binds to `127.0.0.1`, accepts
  only an opaque selector mapped to a configured ARN, rejects a foreign `Host`
  (DNS rebinding), a foreign `Origin`, and non-JSON POST bodies, and returns
  generic errors to the browser. None of that is authentication. A deployed
  endpoint must derive `UserArn` from a verified end-user session, never from
  request input.
- **The embed URL is a bearer credential.** Anyone holding it has that user's
  session until it expires. Do not log it or put it in a URL that reaches
  analytics or access logs.
- **Email is the join key.** Bedrock matches ACL entries on email address,
  case-insensitively, with no alias resolution. If a Quick user's email is
  reassigned to a different person, that person inherits the previous user's
  access.

## Failure behavior worth knowing

ACL-aware retrieval **fails closed**. A document with no ACL coverage is not
ingested, and a wrong email in the ACL file indexes normally but matches nobody.
A misconfiguration therefore presents as "fewer results than expected", not as
an error. The README's Phase 2 describes which mistakes the ingestion job
reports and which it cannot see.

## Architectural boundary

The browser never holds AWS credentials or imports an AWS SDK; ESLint enforces
this for `webapp/src/`. Every AWS call goes through the harness, which keeps the
code that decides the Quick identity in one small, reviewable place.

## Reporting scope

This is a sample intended to be read and adapted, not a supported product.
Please still report security issues through the process above, because a defect
copied out of a sample propagates.
