import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';

export const TEST_ISSUER =
  'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL';
export const TEST_AUDIENCE = 'test-app-client-id';

export interface TokenClaims {
  readonly sub?: string;
  readonly email?: string;
  readonly email_verified?: boolean | string;
  readonly token_use?: string;
  readonly iss?: string;
  readonly aud?: string;
  readonly exp?: number;
  readonly nbf?: number;
}

/**
 * Signs real JWTs with a real RSA keypair for tests.
 *
 * Real signatures rather than a stubbed verifier, because the properties under
 * test are cryptographic. A stub that returns canned claims proves the guard
 * wires up; it proves nothing about whether a forged token is rejected, which is
 * the part that matters. The keypair is generated per test run and the JWKS is
 * served locally, so the suite needs no network access.
 */
export class TokenFactory {
  private constructor(
    private readonly privateKey: CryptoKey,
    readonly publicJwk: JWK,
    readonly getKey: JWTVerifyGetKey,
    /** A second, unrelated keypair, for forging tokens signed by the wrong key. */
    private readonly foreignPrivateKey: CryptoKey,
  ) {}

  static async create(): Promise<TokenFactory> {
    const { privateKey, publicKey } = await generateKeyPair('RS256', {
      extractable: true,
    });
    const foreign = await generateKeyPair('RS256', { extractable: true });

    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'test-key-1';
    publicJwk.alg = 'RS256';

    // Only the legitimate key is published, so a token signed by the foreign key
    // has no resolvable key and fails.
    const getKey = createLocalJWKSet({ keys: [publicJwk] });

    return new TokenFactory(privateKey, publicJwk, getKey, foreign.privateKey);
  }

  /** A token that should verify cleanly. Override any claim to make it not. */
  async sign(overrides: TokenClaims = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      sub: overrides.sub ?? 'test-subject',
      email: overrides.email ?? 'alejandro_rosalez@example.com',
      email_verified: overrides.email_verified ?? true,
      token_use: overrides.token_use ?? 'id',
    };

    // `undefined` must be distinguishable from "not supplied", so callers can
    // omit a claim entirely by passing undefined explicitly.
    for (const key of ['sub', 'email', 'email_verified', 'token_use'] as const) {
      if (key in overrides && overrides[key] === undefined) {
        delete claims[key];
      }
    }

    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(overrides.iss ?? TEST_ISSUER)
      .setAudience(overrides.aud ?? TEST_AUDIENCE)
      .setIssuedAt(now)
      .setNotBefore(overrides.nbf ?? now)
      .setExpirationTime(overrides.exp ?? now + 3600)
      .sign(this.privateKey);
  }

  /** Correctly formed and correctly claimed, but signed by an unpublished key. */
  async signWithForeignKey(overrides: TokenClaims = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: overrides.sub ?? 'test-subject',
      email: overrides.email ?? 'alejandro_rosalez@example.com',
      email_verified: true,
      token_use: 'id',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(overrides.iss ?? TEST_ISSUER)
      .setAudience(overrides.aud ?? TEST_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(this.foreignPrivateKey);
  }

  /**
   * An unsigned token declaring `alg: none`.
   *
   * Hand-assembled, because a correct signing library will not produce one. This
   * is the classic bypass: if the verifier honours the algorithm named in the
   * token's own header, an attacker simply declares that no signature is needed.
   */
  unsignedToken(claims: Record<string, unknown> = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'none', typ: 'JWT' };
    const payload = {
      sub: 'attacker',
      email: 'attacker@example.com',
      email_verified: true,
      token_use: 'id',
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      iat: now,
      exp: now + 3600,
      ...claims,
    };
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode(header)}.${encode(payload)}.`;
  }

  /**
   * A token signed with HMAC-SHA256, using the public key material as the secret.
   *
   * The algorithm-confusion attack. A verifier that does not pin the algorithm
   * will fetch the RSA public key — which is public — and then use those bytes as
   * an HMAC secret, validating a token the attacker signed themselves.
   */
  async algorithmConfusionToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const secret = new TextEncoder().encode(JSON.stringify(this.publicJwk));
    return new SignJWT({
      sub: 'attacker',
      email: 'attacker@example.com',
      email_verified: true,
      token_use: 'id',
    })
      .setProtectedHeader({ alg: 'HS256', kid: 'test-key-1' })
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(secret);
  }
}
