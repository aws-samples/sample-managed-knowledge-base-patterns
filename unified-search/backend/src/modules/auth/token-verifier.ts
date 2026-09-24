import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { VerifiedClaims } from '../../domain/index.js';

/**
 * Raised when a bearer token cannot be trusted, for any reason.
 *
 * Carries no detail about *why* beyond a short reason, and callers must not
 * return that reason to the client. Distinguishing "bad signature" from "expired"
 * from "wrong audience" in an HTTP response tells an attacker which part of a
 * forged token to fix next.
 */
export class TokenVerificationError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = 'TokenVerificationError';
  }
}

/**
 * Verifies a bearer token and returns claims that downstream code may trust.
 *
 * An interface so tests can substitute a stub and so a different identity
 * provider can be added without touching the guard.
 */
export interface TokenVerifier {
  /**
   * @throws {TokenVerificationError} if the token is absent, malformed,
   * unverifiable, or missing a claim required to identify the user.
   */
  verify(token: string): Promise<VerifiedClaims>;
}

export interface CognitoTokenVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUri: string;

  /**
   * Overrides key resolution. Tests supply a local JWKS so the suite runs without
   * network access; production leaves it unset and keys are fetched from the
   * pool's published JWKS endpoint and cached by `jose`.
   */
  readonly getKey?: JWTVerifyGetKey;

  /**
   * Permitted clock skew, in seconds, when evaluating `exp` and `nbf`.
   *
   * Small on purpose. Skew tolerance is a window in which an expired token is
   * still accepted, so it should cover ordinary clock drift and nothing more.
   */
  readonly clockToleranceSeconds?: number;
}

/**
 * The only algorithm accepted.
 *
 * The attacks this defends against are the classic JWT ones: a token presenting
 * `alg: none` to skip signature checking, and `alg: HS256` so a verifier treats
 * the *public* RSA key as an HMAC secret and validates a token the attacker
 * signed themselves. Both work whenever the algorithm is taken from the token's
 * own header.
 *
 * This pin is **defense in depth**. `jose` does not implement `none`, and
 * verifying an HS256 signature against a resolved RSA key fails on a key-type
 * mismatch, so `jose` rejects both attacks even without this option. The pin is
 * kept because it makes the intent explicit and because it would matter under a
 * different verification library or a future `jose` default.
 *
 * Cognito signs with RS256, so nothing else is permitted.
 */
const PERMITTED_ALGORITHMS = ['RS256'] as const;

/** Cognito marks ID tokens with `token_use: 'id'`. */
const REQUIRED_TOKEN_USE = 'id';

/**
 * Verifies Amazon Cognito ID tokens.
 *
 * What this checks, and why each one matters:
 *
 * - **Signature**, against the pool's published JWKS. Without it nothing else
 *   means anything, since the payload is only base64-encoded. Decoding a token to
 *   read claims is not verification.
 * - **Algorithm**, pinned to RS256. See {@link PERMITTED_ALGORITHMS}.
 * - **Issuer**, so a token minted by a different Cognito pool — including one
 *   the attacker controls — is rejected.
 * - **Audience**, so a token issued for a different app client is rejected.
 * - **Expiry and not-before**, with minimal clock tolerance.
 * - **`token_use === 'id'`**, so a Cognito *access* token cannot be substituted.
 *   Access tokens carry no email claim and are issued in flows with different
 *   consent semantics, so they must not be accepted as proof of identity.
 * - **`email_verified === true`**. This is the one that is easy to miss and the
 *   most damaging to omit. The email is the ACL join key: Bedrock matches
 *   document permissions against it. If a pool permits self-service sign-up,
 *   accepting an unverified address lets anyone register under a colleague's
 *   email and inherit that person's document access. An unverified email is an
 *   attacker-controlled string.
 * - **`sub` present**, for correlation.
 *
 * See SECURITY.md.
 */
export class CognitoTokenVerifier implements TokenVerifier {
  private readonly getKey: JWTVerifyGetKey;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly clockToleranceSeconds: number;

  constructor(options: CognitoTokenVerifierOptions) {
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.clockToleranceSeconds = options.clockToleranceSeconds ?? 5;
    this.getKey = options.getKey ?? createRemoteJWKSet(new URL(options.jwksUri));
  }

  async verify(token: string): Promise<VerifiedClaims> {
    if (token.trim() === '') {
      throw new TokenVerificationError('empty token');
    }

    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(token, this.getKey, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: [...PERMITTED_ALGORITHMS],
        clockTolerance: this.clockToleranceSeconds,
      });
      payload = result.payload;
    } catch (error) {
      // Deliberately collapses every cryptographic and temporal failure into one
      // reason. The distinction is useful in a server log, not in a response.
      throw new TokenVerificationError('token failed verification', { cause: error });
    }

    return this.extractClaims(payload);
  }

  /**
   * Reads the identity claims, rejecting anything that would produce an
   * untrustworthy or unusable identity.
   *
   * Runs only on an already signature-verified payload. Order matters for
   * clarity of failure, not for security — every branch rejects.
   */
  private extractClaims(payload: Record<string, unknown>): VerifiedClaims {
    if (payload['token_use'] !== REQUIRED_TOKEN_USE) {
      throw new TokenVerificationError('token is not an ID token');
    }

    const emailVerified = payload['email_verified'];
    // Cognito emits a boolean, but some federated mappings surface the string
    // "true". Both are accepted; anything else — including absence — is not.
    if (emailVerified !== true && emailVerified !== 'true') {
      throw new TokenVerificationError('email address is not verified');
    }

    const email = payload['email'];
    if (typeof email !== 'string' || email.trim() === '') {
      throw new TokenVerificationError('token carries no email claim');
    }

    const subject = payload['sub'];
    if (typeof subject !== 'string' || subject.trim() === '') {
      throw new TokenVerificationError('token carries no subject claim');
    }

    return { email, subject };
  }
}
