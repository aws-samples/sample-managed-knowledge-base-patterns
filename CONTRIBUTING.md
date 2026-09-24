# Contributing Guidelines

Thank you for your interest in contributing. Whether it is a bug report, a new
pattern, a correction, or additional documentation, we value the contribution.

Please read this before opening an issue or a pull request. Individual patterns
add their own standards, so also read the `CONTRIBUTING.md` in the pattern
directory you are changing if it has one.

## Reporting bugs and requesting features

Use the issue tracker. Check existing open and recently closed issues first.

Always name the pattern directory the issue applies to. A report that does not
say which pattern it concerns cannot be acted on, because the patterns share no
code.

Useful details:

- A reproducible test case or series of steps
- Which pattern, and which part of it
- Anything unusual about your environment, region, or account configuration

**Scrub identifiers before pasting.** AWS account IDs, knowledge base IDs,
tenant IDs, ARNs, and document excerpts routinely appear in the error output and
diagnostics these patterns produce.

## Contributing changes to an existing pattern

1. Work against the latest source on the `main` branch.
2. Check existing open and recently merged pull requests.
3. Open an issue to discuss significant work first, so your time is not wasted.
4. Keep the change scoped to one pattern where possible. A change spanning
   several patterns is harder to review and usually means something belongs in
   one of them rather than all of them.
5. Run the pattern's own checks. Each pattern's README states the commands, and
   CI runs them per pattern.
6. Add tests for new behavior.
7. Do not reformat code you are not changing. It buries the actual change.

## Contributing a new pattern

A new pattern is a new top-level directory. It must:

- Be deployable and testable on its own, with no dependency on another pattern
- Contain a `README.md` that stands alone: what it demonstrates, prerequisites,
  what gets deployed, the standing cost, and how to tear it down
- Include the sparse-checkout instructions for its own directory, so a reader who
  arrives at the pattern directly can get just that pattern
- Use only fictitious names drawn from the AWS approved fictitious content
  library, and example bucket names carrying the `amzn-s3-demo-` prefix
- Commit no account IDs, pool IDs, ARNs, hostnames, or stand-in user identities.
  Those are configuration, not code
- Add its own path-filtered CI workflow, because patterns do not share a build
  system or a language

Add the pattern to the table in the root `README.md` in the same change.

## Code of conduct

This project has adopted the
[Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct). For
more information see the
[Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact
opensource-codeofconduct@amazon.com with any additional questions or comments.

## Security issue notifications

See [SECURITY.md](SECURITY.md). Please do **not** create a public issue for a
security problem.

## Licensing

See the [LICENSE](LICENSE) file. We will ask you to confirm the licensing of
your contribution.
