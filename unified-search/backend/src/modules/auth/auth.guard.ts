import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { UserIdentity } from '../../domain/index.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { TOKEN_VERIFIER, type TokenVerifier } from './token-verifier.tokens.js';
import { TokenVerificationError } from './token-verifier.js';

/**
 * Property on the Express request where the verified identity is stashed.
 *
 * Deliberately obscure and not part of any public type. Handlers reach the
 * identity through the `@CurrentUser()` decorator; nothing should be reading this
 * key directly, and a name like `user` would invite exactly that.
 */
export const IDENTITY_REQUEST_KEY = '__verifiedUserIdentity';

/**
 * Authenticates every request, and is registered globally.
 *
 * Global registration is the design: a guard applied per-controller protects only
 * the controllers someone remembered to annotate, so an endpoint added later would
 * default to open. Here a new endpoint defaults to closed and opening one requires
 * {@link Public}.
 *
 * The guard is the **only** place a {@link UserIdentity} is created from a
 * request. That matters because the identity is what Bedrock filters documents
 * by: it must come from a verified token signature and never from anything the
 * caller can set directly. A request body, query parameter, or custom header
 * carrying an email is ignored here and must stay ignored. See SECURITY.md.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractBearerToken(request.headers.authorization);

    if (token === undefined) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const claims = await this.verifier.verify(token);
      const identity = UserIdentity.fromVerifiedClaims(claims);

      // Assigned only here, only after verification.
      (request as unknown as Record<string, unknown>)[IDENTITY_REQUEST_KEY] = identity;

      return true;
    } catch (error) {
      // The reason is logged, never returned. Telling a caller whether a forged
      // token failed on signature, audience, or expiry tells them what to fix.
      const reason =
        error instanceof TokenVerificationError || error instanceof Error
          ? error.message
          : 'unknown';
      this.logger.warn(`Rejected request: ${reason}`);
      // Names no cause. "Invalid or expired token" would already be an
      // improvement over a specific reason, but it still enumerates a
      // possibility; a single opaque message keeps every rejection identical.
      throw new UnauthorizedException('Invalid credentials');
    }
  }

  /**
   * Pulls the credential out of an `Authorization: Bearer <token>` header.
   *
   * The scheme comparison is case-insensitive because RFC 7235 defines it that
   * way, and clients do send `bearer`. Anything that is not exactly two
   * whitespace-separated parts with a `Bearer` scheme is rejected rather than
   * salvaged.
   */
  private extractBearerToken(header: string | undefined): string | undefined {
    if (header === undefined) {
      return undefined;
    }

    const parts = header.trim().split(/\s+/);
    if (parts.length !== 2) {
      return undefined;
    }

    const [scheme, credential] = parts;
    if (scheme?.toLowerCase() !== 'bearer') {
      return undefined;
    }
    if (credential === undefined || credential.trim() === '') {
      return undefined;
    }

    return credential;
  }
}
