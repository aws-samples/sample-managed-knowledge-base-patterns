/**
 * Base class for failures originating in the retrieval layer.
 *
 * Providers translate AWS SDK exceptions into these so that nothing above the
 * provider boundary depends on SDK exception classes. Controllers handle a small,
 * stable set of domain errors, and the mapping from SDK exceptions lives in one
 * reviewable place.
 */
export class RetrievalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Access-control evaluation failed, so results are known to be incomplete.
 *
 * This is distinct from an empty result set, and the distinction is the whole
 * reason the type exists. ACL-aware retrieval **fails closed** as a secure
 * default: if group resolution fails, a real-time permission check times out,
 * or the service hits an internal error, the affected documents are omitted
 * rather than returned. Raising this error lets the application tell that case
 * apart from "nothing matched".
 *
 * Callers should tell the user their results may be incomplete rather than
 * silently presenting a short list as if it were the whole answer.
 */
export class AclEvaluationError extends RetrievalError {}

/**
 * The knowledge base or data source named in the request does not exist, or the
 * caller's credentials cannot reach it.
 */
export class SourceUnavailableError extends RetrievalError {}

/**
 * The request was rejected before retrieval — an unusable continuation token, a
 * query that exceeds a service limit, or similar.
 */
export class InvalidQueryError extends RetrievalError {}

/**
 * The requested document cannot be served to this user.
 *
 * **One error for two causes, deliberately.** The document may not exist, or it may
 * exist and be denied to this user, and this type does not distinguish them —
 * because distinguishing them tells an unauthorized caller which documents exist.
 *
 * `GetDocumentContent` returns distinct errors for the two cases —
 * `AccessDeniedException` for a document the user may not read and
 * `ResourceNotFoundException` for one that does not exist — which suits callers
 * authenticated with their own IAM credentials. This API relays requests on behalf
 * of end users, so it collapses both into this error. That way a user who can read
 * nothing in a folder cannot infer which file names exist there, which for
 * documents named after their subject ("acquisition-anycompany-terms.md") can be
 * the sensitive part.
 *
 * Legitimate users get a less specific message as a result. Operators who need the
 * underlying reason use `make acl-check`, which runs under IAM rather than under an
 * end user's session.
 */
export class DocumentNotAvailableError extends RetrievalError {}
