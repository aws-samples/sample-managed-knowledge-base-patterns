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

- The command, in Python or TypeScript, and its full output
- The output of `status`, for problems with ingestion or the instructions
- Which optional parts you deployed (tenant roles, the South knowledge base,
  combined cells)
- Any modifications you've made relevant to the bug

**Scrub identifiers before pasting.** AWS account IDs, knowledge base and
instruction IDs, ARNs, and request IDs appear in this project's output and in
`sample-state.json`.

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
3. Ensure local checks pass, from the `retrieval-instructions` directory:
   ```bash
   npm ci
   uv sync --locked
   npm run verify
   uv run --frozen ruff check python
   uv run --frozen ruff format --check python
   uv run --frozen mypy --strict
   uv run --frozen pytest
   UV_PROJECT_ENVIRONMENT=.venv-py310 uv run --locked --python 3.10 pytest
   ```
   `npm run verify` synthesizes the stack for the example account
   `123456789012`, so it needs no AWS credentials, and nothing is deployed.
4. Add tests for new behavior, in both languages.
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

- **A filter or tenant taken from the question or other request input.** Amazon
  Bedrock applies whatever filter the request sends. See [SECURITY.md](SECURITY.md).
- **A filter built outside `tenancy`**, an import of the filter builders (`eq`,
  `filter_for`, `filterFor`) in any other module, or a request sent outside
  `ask_as_tenant` and `send_request` (`askAsTenant`, `sendRequest`).
- **A claim or code comment that an instruction isolates tenants.** It doesn't. The
  filter does.
- **Making an optional part required** for the core walkthrough: the tenant roles,
  the South knowledge base, combined cells, the data-event trail, or a KMS key.
- **A command in one language only, or output that differs between languages.** Add
  the expected output to `test-fixtures/expected/` and test both formatters against
  it.
- **Committed IDs, ARNs, state files, or captured output.** Account IDs, knowledge
  base and instruction IDs, `sample-state.json`, and `cdk.out` are environment
  specific. Examples use `123456789012` and masked IDs such as `abcde12345`.
- **A wildcard or a new cdk-nag acknowledgment without a written reason.**
- **A corpus change that fails the corpus lint** (`infra/test/corpus.test.ts`). Each
  metadata file must equal its entry in `corpus/manifest.json`, and every name, email
  address, and phone number must be fictitious.
- **A test that asserts nothing.** An empty test body reads as coverage in CI while
  verifying nothing.
- **Unverified claims about service behavior.** A new or changed claim must have
  been observed against the service, and the pull request should say how. Mark
  anything you couldn't verify as unverified.

## Code Style

- Python 3.10 or later, checked with ruff and `mypy --strict`. TypeScript with
  eslint (`--max-warnings 0`) and prettier. Node.js 22 or later; CI runs Node 22.
- Keep request building, stream parsing, and output formatting free of AWS calls, so
  they stay unit-testable.
- Keep the code that matches the post's snippets line for line where possible.
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
