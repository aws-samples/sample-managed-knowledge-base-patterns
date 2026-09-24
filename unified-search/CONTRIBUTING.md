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
- Which surface is involved (search, chat, document viewer, infrastructure)
- The connector type and whether ACL awareness is enabled on it
- Any modifications you've made relevant to the bug
- Anything unusual about your environment or deployment

**Scrub identifiers before pasting.** AWS account IDs, knowledge base IDs,
tenant IDs, ARNs, and document excerpts routinely appear in this project's error
output and diagnostics.

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
   npm run lint
   npm test
   npm run synth
   ```
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

- **An authentication bypass flag.** Not for local development, not behind an
  environment check. See [SECURITY.md](SECURITY.md).
- **A user identity read from a request body, query parameter, or header.** The
  identity passed to Bedrock comes from a verified token, server-side, always.
- **AWS SDK types outside `backend/src/providers/`.** Enforced by ESLint.
- **Mock data on a live code path.** Fixtures belong in tests, so a mock-mode
  switch in application code will be declined.
- **A second implementation of something that already exists.** If the existing
  one needs to change, change it. Parallel implementations of authentication,
  provisioning, or API clients tend to drift apart.
- **Placeholder or environment-specific values in committed code.** Account IDs,
  tenant IDs, pool IDs, certificate ARNs, hostnames, and stand-in user
  identities are configuration.
- **A test that asserts nothing.** An empty test body reads as coverage in CI
  while verifying nothing.
- **Broad IAM.** Service-wide wildcards (`s3:*`, `bedrock:*`) or
  `Resource: '*'` need a written justification in the pull request.

## Code Style

- TypeScript throughout. Node 22+.
- Linting is enforced in CI as a blocking check.
- Keep the retrieval provider behind the `RetrievalProvider` port in
  `backend/src/domain/`. Controllers return domain DTOs, never a raw SDK
  response.
- Domain types are named for the domain, not the SDK. `SearchHit`, not
  `RetrievalResult`.
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
