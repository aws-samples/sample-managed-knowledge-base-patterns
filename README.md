# Managed Knowledge Base Patterns

Reference implementations for [Amazon Bedrock Managed Knowledge Base](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-build-managed.html).

Each pattern in this repository is a separate, self-contained solution. A pattern
deploys on its own, is read on its own, and carries its own architecture notes,
tests, and infrastructure. Nothing is shared between patterns except the license
and the secret scanning that runs across the whole repository, so you can take
one pattern and ignore the rest.

The patterns are written to be read as much as run. Each one records why it is
built the way it is, including the alternatives considered, because the
reasoning is usually the part worth reusing.

## Patterns

| Pattern | What it demonstrates |
| --- | --- |
| [unified-search](unified-search/) | Enterprise search and chat over a managed knowledge base with document-level access control, where two authenticated users issuing the same query receive different documents and a third receives nothing. React, NestJS, CDK. |

## Getting one pattern

You almost certainly want a single pattern rather than the whole repository. Git
can fetch just one directory, and with `--filter=blob:none` it does not download
the file contents of the patterns you skipped.

```bash
# Clone the repository structure without any file contents
git clone --filter=blob:none --sparse \
  https://github.com/aws-samples/sample-managed-knowledge-base-patterns.git
cd sample-managed-knowledge-base-patterns

# Fetch only the pattern you want
git sparse-checkout set unified-search

cd unified-search
```

To add a second pattern later, run `git sparse-checkout add <pattern>`. To see
what you currently have, run `git sparse-checkout list`.

## Getting everything

```bash
git clone https://github.com/aws-samples/sample-managed-knowledge-base-patterns.git
cd sample-managed-knowledge-base-patterns
```

## Conventions

Every pattern directory contains a `README.md` that stands alone: prerequisites,
what gets deployed, what it costs, and how to tear it down. Start there rather
than here.

Patterns do not share a build system or a language. Each one declares its own
prerequisites and its own commands, so the pattern's README is the authority on
how to build and test it.

Deploying any pattern creates real AWS resources and incurs charges. Each README
states the standing cost before you start.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Individual patterns may add their own
standards, in which case the pattern directory carries its own
`CONTRIBUTING.md`.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md). Do not open a public
issue for a security problem.

These are samples intended to be read and adapted, not supported products.
Please still report security issues, because a defect copied out of a sample
propagates.

## License

MIT-0. See [LICENSE](LICENSE).
