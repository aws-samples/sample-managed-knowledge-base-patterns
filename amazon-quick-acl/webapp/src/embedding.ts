import { createEmbeddingContext } from 'amazon-quicksight-embedding-sdk';

type EmbeddingContext = Awaited<ReturnType<typeof createEmbeddingContext>>;

let contextPromise: Promise<EmbeddingContext> | undefined;

/**
 * One embedding context for the life of the page.
 *
 * Each `createEmbeddingContext()` call appends a hidden control iframe to <body> that the
 * SDK never removes, so creating one per identity switch leaks an iframe every time. The
 * context is not tied to a user or an embed URL; it can host any number of successive
 * `embedQuickChat` calls, so it is created once and reused.
 *
 * A failed creation is not cached, so a transient failure can be retried.
 */
export function getEmbeddingContext(): Promise<EmbeddingContext> {
  contextPromise ??= createEmbeddingContext().catch((err: unknown) => {
    contextPromise = undefined;
    throw err;
  });
  return contextPromise;
}
