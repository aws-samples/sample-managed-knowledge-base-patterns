# Security Policy

## Reporting a Vulnerability

If you discover a potential security issue in this project, we ask that you
notify AWS/Amazon Security via our
[vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/)
or directly via email to aws-security@amazon.com.

Please do **not** create a public GitHub issue for security vulnerabilities.

## The security property this sample depends on

Read this before changing anything under `backend/src/modules/auth/` or
`backend/src/providers/`.

Amazon Bedrock Managed Knowledge Base provides **ACL-aware filtering** for the
identity context your application supplies. Per the
[AWS documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-acl.html),
authenticating end users is the application's responsibility: the application
authenticates the user and passes verified identity context, and Bedrock applies
document permissions for that identity.

Retrieval calls carry the user's identity as an ordinary request field:

```json
{ "userContext": { "userId": "user@example.com" } }
```

Everything a user is permitted to see therefore depends on that email being
correct. The consequences:

- **`userContext.userId` is derived server-side from a cryptographically
  verified token.** Never from a request body, query parameter, or custom
  header. A caller-supplied identity is a direct read-anything privilege
  escalation against every ACL-enabled data source in the knowledge base.
- **Token verification is a security control, not a parsing step.** Verification
  means JWKS signature validation plus `iss`, `aud`, `exp`, and `nbf` checks,
  with claims read only from the verified payload. Decoding a JWT to read its
  claims without validating the signature is not verification.
- **There is no authentication bypass, in any environment.** A `BYPASS_AUTH`-style
  flag added for local convenience is indistinguishable from a real one once it
  ships, and `no-bypass.spec.ts` fails the build if one appears. Do not
  reintroduce one; run against a real identity provider instead.
- **Email is the join key.** Bedrock matches document ACLs on the email address
  itself, and aliases are not resolved across identity providers. The verified email must match the email
  in each connected data source. If a user's email is reassigned to a different
  person, that person inherits the previous user's access until the next sync;
  identity lifecycle management is the application's responsibility.

## Failure behavior worth knowing

ACL-aware retrieval **fails closed**. Any error in ACL evaluation omits documents
rather than returning them, and a document with missing ACL metadata is treated
as inaccessible rather than public. This is the safe direction to fail, and it
means a misconfiguration presents as "fewer results than expected" rather than as
an error.

So confirming access is a first-class task rather than an inference.
`CheckIngestedDocumentAcl` and `GetIngestedDocumentAcl` answer it directly, and
this project exposes them through the `make acl-check` operator command rather
than an HTTP endpoint, because `GetIngestedDocumentAcl` returns a document's full
allow list and this application has no authorization model to gate that behind.

## Architectural boundary

`@aws-sdk/client-bedrock-agent-runtime` and `@aws-sdk/client-bedrock-agent` may
only be imported beneath `backend/src/providers/`. This is enforced by ESLint,
not convention. Keeping SDK response shapes out of controllers and UI types keeps
the rest of the application small and stable, and the boundary is also where
`userContext` is attached, so keeping it narrow keeps the security-relevant
surface reviewable.

## Reporting scope

This is a sample intended to be read and adapted, not a supported product.
Please still report security issues through the process above, because a defect
copied out of a sample propagates.
