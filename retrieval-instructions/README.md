# Per-tenant retrieval instructions for Amazon Bedrock Managed Knowledge Base

Give each tenant of one shared
[Amazon Bedrock Managed Knowledge Base](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-build-managed.html)
its own voice, answer format, and pinned retrieval instruction version, while a
metadata filter built on the server keeps each tenant to its own documents. The sample
is the companion code of the AWS blog post "Customize answers per tenant in Amazon
Bedrock Managed Knowledge Base".

## Getting this sample

This sample lives in the
[sample-managed-knowledge-base-patterns](https://github.com/aws-samples/sample-managed-knowledge-base-patterns)
repository alongside other patterns that share no code with it. To get only this one,
have git fetch only this directory. With `--filter=blob:none` the file contents of the
other patterns are never downloaded.

```bash
# Clone the repository structure without any file contents
git clone --filter=blob:none --sparse \
  https://github.com/aws-samples/sample-managed-knowledge-base-patterns.git
cd sample-managed-knowledge-base-patterns

# Fetch only this sample
git sparse-checkout set retrieval-instructions

cd retrieval-instructions
```

Commands in this README run from the `retrieval-instructions` directory.

## License

MIT-0. See [LICENSE](../LICENSE).
