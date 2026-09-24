import {
  AccessDeniedException,
  DependencyFailedException,
  ResourceNotFoundException,
  ThrottlingException,
  ValidationException,
} from '@aws-sdk/client-bedrock-agent-runtime';

import {
  AclEvaluationError,
  InvalidQueryError,
  RetrievalError,
  SourceUnavailableError,
} from '../../domain/index.js';

/**
 * Translates Bedrock SDK exceptions into domain errors.
 *
 * The point of the boundary: nothing above `src/providers/` should have to know
 * that `ValidationException` exists. Controllers handle a small, stable set of
 * domain errors, and the mapping from SDK exceptions stays in this one reviewable
 * place.
 *
 * ## What is deliberately *not* mapped
 *
 * {@link InvalidQueryError} covers request validation failures
 * (`ValidationException`), such as an empty query. Continuation tokens are opaque
 * and passed through unchanged. See DESIGN.md.
 *
 * There is no mapping that produces {@link AclEvaluationError} from a successful
 * response. ACL evaluation is fail-closed by design: documents the user may not
 * read are left out and the call succeeds, so the response does not reveal whether
 * a document was withheld or never matched. That error is reserved for the case
 * where the service reports a dependency failure while evaluating access.
 */
export function toDomainError(error: unknown, operation: string): RetrievalError {
  if (error instanceof RetrievalError) return error;

  if (error instanceof ValidationException) {
    return new InvalidQueryError(
      `Bedrock rejected the ${operation} request: ${error.message}`,
      { cause: error },
    );
  }

  if (error instanceof ResourceNotFoundException) {
    return new SourceUnavailableError(
      `The knowledge base or data source named in the ${operation} request does not exist.`,
      { cause: error },
    );
  }

  if (error instanceof AccessDeniedException) {
    // The application's own credentials, not the end user's permissions. A user
    // who lacks document access gets an empty result set, never this.
    //
    // With one exception, which is why `getDocument` handles these two exception
    // types itself before delegating here: `GetDocumentContent` DOES make an access
    // decision about the end user, and raises `AccessDeniedException` when that user
    // may not read the document. Routing that case through this mapping would tell an
    // operator to go and inspect a task role that is working correctly.
    return new SourceUnavailableError(
      `This service's credentials are not permitted to call ${operation} on the ` +
        'configured knowledge base. Check the task role policy, not the user.',
      { cause: error },
    );
  }

  if (error instanceof DependencyFailedException) {
    // Group resolution and real-time permission checks are downstream
    // dependencies, so a dependency failure during retrieval means results may be
    // incomplete for permission reasons. The caller is told, so a short list is
    // not presented as a complete one.
    return new AclEvaluationError(
      `${operation} could not complete because a dependency was unavailable; ` +
        'results may be incomplete, so none are returned.',
      { cause: error },
    );
  }

  if (error instanceof ThrottlingException) {
    return new RetrievalError(`Bedrock throttled the ${operation} request.`, {
      cause: error,
    });
  }

  return new RetrievalError(
    `Unexpected failure calling ${operation}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}
