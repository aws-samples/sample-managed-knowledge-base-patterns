/**
 * Errors the commands raise, each with its exit code.
 *
 * Exit codes: 0 success, 1 a check the command performs failed, 2 a usage error or a guard
 * refused, 3 an AWS error that isn't a check result (including credential and network errors).
 */

/** An error the CLI prints as one `error: ...` line on stderr before it exits. */
export class SampleError extends Error {
  readonly exitCode: number = 3;
}

/** A check the command performs failed (exit 1). */
export class CheckFailed extends SampleError {
  override readonly exitCode = 1;
}

/** A bad option, a refused guard, or a missing prerequisite (exit 2). */
export class UsageError extends SampleError {
  override readonly exitCode = 2;
}

/** An AWS error that isn't a check result (exit 3). */
export class AwsError extends SampleError {
  override readonly exitCode = 3;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(code: string, message: string, requestId?: string, hint?: string) {
    let text = `${code}: ${message}`;
    if (requestId) text += ` (request ID ${requestId})`;
    if (hint) text += `. ${hint}`;
    super(text);
    this.code = code;
    this.requestId = requestId;
  }
}

/** An error an AWS SDK client raised for a service response. */
export interface ServiceError extends Error {
  $metadata: { requestId?: string };
}

export function isServiceError(err: unknown): err is ServiceError {
  return err instanceof Error && '$metadata' in err;
}

/** The error code (the exception name) of an SDK service error, or an empty string. */
export function errorCode(err: unknown): string {
  return isServiceError(err) ? err.name : '';
}

/** Convert an SDK service error into an AwsError with its code, message, and request ID. */
export function awsError(err: unknown, hint?: string): AwsError {
  if (isServiceError(err)) {
    return new AwsError(err.name, err.message, err.$metadata.requestId, hint);
  }
  return new AwsError('Error', String(err), undefined, hint);
}
