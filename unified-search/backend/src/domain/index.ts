/**
 * The domain layer: provider-agnostic types and the retrieval port.
 *
 * Nothing in this directory imports an AWS SDK, and nothing in it should. A test
 * asserts that property so it cannot regress quietly.
 */
export type {
  ChatEvent,
  ChatRequest,
  ChatTrace,
  ChatTurn,
  Citation,
  CitationReference,
  CitationSpan,
} from './chat.js';
export { collectChat } from './chat.js';
export type { DocumentContent } from './documents.js';
export type { SearchHit, SearchPage, SearchQuery } from './search.js';
export type { AclFilteringStatus, KnowledgeSource, SourceType } from './sources.js';
export type { VerifiedClaims } from './identity.js';
export type { RetrievalCapabilities, RetrievalProvider } from './retrieval-provider.js';

export { UserIdentity } from './identity.js';
export { RETRIEVAL_PROVIDER } from './retrieval-provider.js';
export {
  AclEvaluationError,
  DocumentNotAvailableError,
  InvalidQueryError,
  RetrievalError,
  SourceUnavailableError,
} from './errors.js';
