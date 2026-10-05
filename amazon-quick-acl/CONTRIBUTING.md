# Contributing Guidelines

Thank you for your interest in contributing to this project. Whether it's a bug
report, new feature, correction, or additional documentation, we greatly value
feedback and contributions.

Please read through this document before submitting any issues or pull requests
so we have the information needed to respond effectively.

## Reporting Bugs/Feature Requests

We welcome you to use the GitHub issue tracker to report bugs or suggest
features.

When filing an issue, please check existing open, or recently closed, issues to
make sure somebody else hasn't already reported it. Details like the following
are useful:

- A reproducible test case or series of steps
- Which phase is involved (deploy, ingestion, Quick wiring, embedded web app)
- The ingestion job statistics, if the problem is missing or unexpected answers
- The Quick role of each demo user (`READER_PRO` or otherwise)
- Any modifications you've made relevant to the bug
- Anything unusual about your environment or deployment

**Scrub identifiers before pasting.** AWS account IDs, knowledge base IDs, Quick
user ARNs, email addresses, embed URLs, and document excerpts routinely appear in
this project's error output and diagnostics. An embed URL is a bearer credential;
never paste a live one.

## Contributing via Pull Requests

Before sending a pull request, please ensure that:

1. You are working against the latest source on the _main_ branch.
2. You have checked existing open and recently merged pull requests.
3. You have opened an issue to discuss any significant work. We would hate for
   your time to be wasted.

To send us a pull request:

1. Fork the repository.
2. Modify the source; please focus on the specific change you are contributing.
   If you also reformat all the code, it will be hard for us to focus on your
   change.
3. Ensure local checks pass:
   ```bash
   npm install
   KB_TARGET_ACCOUNT=123456789012 KB_TARGET_REGION=us-east-1 npm run verify
   ```
   The two variables are only needed when you have no `infra/.env`; nothing is
   deployed.
4. Add tests for new behavior.
5. Commit to your fork using clear commit messages.
6. Send us a pull request, answering any default questions in the interface.
7. Pay attention to any automated CI failures, and stay involved in the
   conversation.

GitHub provides additional documentation on
[forking a repository](https://help.github.com/articles/fork-a-repo/) and
[creating a pull request](https://help.github.com/articles/creating-a-pull-request/).

## Things this project will not accept

These are listed explicitly because each one is a defect that ships easily and is
expensive to unpick later.

- **A harness that takes an identity from the request.** The browser sends an
  opaque selector and the harness maps it to a configured ARN. Accepting an ARN,
  email, or user name from a request body, query parameter, or header lets anyone
  open a session as any Quick user. See [SECURITY.md](SECURITY.md).
- **Weakening the harness boundary.** It binds to `127.0.0.1` and rejects a
  foreign `Host`, a foreign `Origin`, and non-JSON POST bodies. Each check has a
  test; removing one needs a written reason in the pull request.
- **Deployment infrastructure for the harness** without real end-user
  authentication in front of it. `webapp/server/` is a local development tool.
- **An AWS SDK in the browser.** Everything AWS-facing goes through the harness.
  Enforced by ESLint.
- **Demo users who differ in Quick access.** Both users get identical space and
  knowledge base sharing, so the only difference between them is
  `global-acl.json`. Separating them through Quick sharing produces a
  convincing result that does not demonstrate ACL filtering.
- **Unverified failure-mode claims.** A new or changed claim about Bedrock or
  Quick behavior must have been observed against a live deployment, and the pull
  request should say how. Mark anything you could not verify as unverified.
- **Placeholder or environment-specific values in committed code.** Account IDs,
  ARNs, knowledge base IDs, real email addresses, `.env` files,
  `cdk-outputs.json`, and the rendered `global-acl.json` are configuration.
- **A test that asserts nothing.** An empty test body reads as coverage in CI
  while verifying nothing.
- **Broad IAM.** Service-wide wildcards (`s3:*`, `bedrock:*`) or
  `Resource: '*'` need a written justification in the pull request, and any new
  cdk-nag acknowledgment needs a recorded reason.

## Code Style

- TypeScript throughout. Node 20.19+ or 22.12+; CI runs Node 22.
- Linting is enforced in CI and is not advisory.
- Keep pure logic (environment resolution, ACL rendering, sharing evaluation,
  request handling) in modules with no AWS or file system access, so it can be
  tested directly.
- Prefer deleting code over commenting it out.

## Code of Conduct

This project has adopted the
[Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct).
For more information see the
[Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact
opensource-codeofconduct@amazon.com with any additional questions or comments.

## Security Issue Notifications

If you discover a potential security issue, please notify AWS/Amazon Security
via our
[vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/).
Please do **not** create a public GitHub issue.

## Licensing

See the [LICENSE](../LICENSE) file. We will ask you to confirm the licensing of
your contribution.
