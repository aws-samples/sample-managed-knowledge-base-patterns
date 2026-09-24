import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { UserIdentity } from '../../domain/index.js';
import { IDENTITY_REQUEST_KEY } from './auth.guard.js';

/**
 * Injects the verified {@link UserIdentity} into a handler parameter.
 *
 * ```ts
 * search(@CurrentUser() identity: UserIdentity, @Body() body: SearchDto) { ... }
 * ```
 *
 * Throws if no identity is present rather than returning `undefined`. That case
 * should be unreachable — the global guard runs first and rejects unauthenticated
 * requests — so reaching it means the route was marked `@Public()` while still
 * expecting a user, and the correct response is a loud failure during
 * development rather than a `undefined` flowing onward. An identity that arrives
 * as `undefined` would eventually be passed to retrieval, where ACL-enabled
 * sources return no results without a user context (the secure default), which
 * is easy to mistake for an empty index.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): UserIdentity => {
    const request = context.switchToHttp().getRequest<Request>();
    const identity = (request as unknown as Record<string, unknown>)[
      IDENTITY_REQUEST_KEY
    ];

    if (!(identity instanceof UserIdentity)) {
      throw new Error(
        'No verified identity on request. @CurrentUser() requires the global ' +
          'AuthGuard to have run — is this route marked @Public()?',
      );
    }

    return identity;
  },
);
