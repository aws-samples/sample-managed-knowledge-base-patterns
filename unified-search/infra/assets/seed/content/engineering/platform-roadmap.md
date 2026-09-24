# Platform Roadmap

AnyCompany — Engineering team. All content is fictional.

## Q3 themes

1. **Retrieval quality.** Replace the keyword-only search path with hybrid
   retrieval and measure against a ground-truth question set.
2. **Ingestion throughput.** The in-house document indexer processes roughly 400
   documents per minute; the target is 1,500.
3. **Observability.** Add per-document status reporting to the indexer's batch
   import dashboard.

## Deprecations

The v1 search endpoint is deprecated and will be removed once no client has called
it for 30 consecutive days.

## Open questions

Whether to expose relevance scores directly in the API response, or to bucket them
into coarse bands. AnyCompany's search scores are not normalized across queries, so
exposing them raw could be misread.
