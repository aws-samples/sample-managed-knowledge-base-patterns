import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

import {
  AclEvaluationError,
  DocumentNotAvailableError,
  InvalidQueryError,
  RetrievalError,
  SourceUnavailableError,
} from '../../domain/index.js';

/**
 * Turns domain retrieval errors into HTTP responses.
 *
 * Registered once rather than repeated per controller, and it catches the **domain**
 * error type rather than any SDK exception — the provider has already translated
 * those, and this filter would be the wrong place to learn about them. Returning
 * raw SDK exceptions to callers leaks internal detail and makes the API shape
 * depend on SDK exception classes.
 *
 * The status codes encode whose problem each failure is:
 *
 * - {@link InvalidQueryError} is the caller's — a malformed query.
 * - {@link SourceUnavailableError} is the deployment's — a missing knowledge base or
 *   a task role lacking permission. Not the caller's fault, so not a 4xx, and
 *   notably not something a user can fix by retrying with different input.
 * - {@link AclEvaluationError} means results would be incomplete for permission
 *   reasons. Returning a short list with a 200 would present an incomplete answer as
 *   a complete one, which is the failure this error type exists to prevent.
 */
@Catch(RetrievalError)
export class RetrievalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(RetrievalExceptionFilter.name);

  catch(error: RetrievalError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, message } = classify(error);

    // The full error, including its `cause`, stays server-side. The client gets a
    // stable message and nothing about the internals.
    this.logger.error(`${error.name}: ${error.message}`, error.stack);

    if (response.headersSent) {
      // A streaming response already committed a 200, so the status is no longer
      // ours to set. The chat controller reports mid-stream failures as an SSE
      // `error` event; reaching here means the stream ended some other way, and the
      // only thing left is to stop writing.
      response.end();
      return;
    }

    response.status(status).json({ statusCode: status, message });
  }
}

function classify(error: RetrievalError): { status: number; message: string } {
  if (error instanceof DocumentNotAvailableError) {
    // 404 for a denied document as well as a missing one, and the same message for
    // both. A 403 would confirm the document exists, which is precisely the
    // information a user without access should not be able to obtain — see
    // DocumentNotAvailableError for why the two causes are collapsed.
    return {
      status: HttpStatus.NOT_FOUND,
      message:
        'That document is not available. It may not exist, or you may not have ' +
        'permission to read it.',
    };
  }

  if (error instanceof InvalidQueryError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      message: 'The query could not be processed as written.',
    };
  }

  if (error instanceof AclEvaluationError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message:
        'Access control could not be evaluated, so results would be incomplete. ' +
        'No partial results are returned. Please retry.',
    };
  }

  if (error instanceof SourceUnavailableError) {
    return {
      status: HttpStatus.BAD_GATEWAY,
      message:
        'The knowledge base is not reachable with this deployment’s credentials.',
    };
  }

  return { status: HttpStatus.BAD_GATEWAY, message: 'Retrieval failed.' };
}
