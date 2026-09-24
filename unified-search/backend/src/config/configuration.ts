/**
 * Application configuration.
 *
 * Two rules this file exists to enforce:
 *
 * 1. **One source of truth per value.** Reading the same knowledge base
 *    identifier from several competing places lets endpoints disagree about
 *    which one won, and the disagreement is invisible until a query returns
 *    nothing.
 *
 * 2. **Keys describe purpose.** `KNOWLEDGE_BASE_ID`, `MEMORY_ID` and
 *    `CORS_ALLOWED_ORIGINS` say what a value is for. Where a key names a
 *    service, as the `COGNITO_*` keys do, it is because the value is specific
 *    to that service.
 *
 * Required values are validated at startup by {@link validateConfig}, which
 * throws rather than allowing the process to come up half-configured. A service
 * that starts and then fails every request is harder to diagnose than one that
 * refuses to start.
 */

export interface AuthConfig {
  /**
   * Amazon Cognito user pool ID, e.g. `us-east-1_ABC123DEF`.
   *
   * The issuer and JWKS URLs are derived from this rather than configured
   * separately, so they cannot drift out of agreement with each other.
   */
  readonly userPoolId: string;

  /** Cognito app client ID. Verified against the token's `aud` claim. */
  readonly clientId: string;

  /** Region hosting the user pool. */
  readonly region: string;
}

export interface AppConfig {
  readonly port: number;
  readonly aws: {
    readonly region: string;
  };
  /**
   * Exact origins permitted to call this API, comma-separated in
   * `CORS_ALLOWED_ORIGINS`.
   *
   * Deliberately has no default and no wildcard. `origin: '*'` with
   * `credentials: true` is both a security finding and a combination browsers
   * reject, so only exact origins are accepted.
   */
  readonly corsAllowedOrigins: readonly string[];
  readonly auth: AuthConfig;
}

export default (): AppConfig => {
  const region = process.env.AWS_REGION ?? 'us-east-1';

  return {
    port: Number.parseInt(process.env.PORT ?? '3001', 10),
    aws: { region },
    corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    auth: {
      userPoolId: process.env.COGNITO_USER_POOL_ID ?? '',
      clientId: process.env.COGNITO_CLIENT_ID ?? '',
      region: process.env.COGNITO_REGION ?? region,
    },
  };
};

/** Cognito's issuer URL for a given pool. */
export function cognitoIssuer(auth: AuthConfig): string {
  return `https://cognito-idp.${auth.region}.amazonaws.com/${auth.userPoolId}`;
}

/** Cognito's published JWKS endpoint for a given pool. */
export function cognitoJwksUri(auth: AuthConfig): string {
  return `${cognitoIssuer(auth)}/.well-known/jwks.json`;
}

/**
 * Fails fast on missing authentication configuration.
 *
 * Authentication settings are validated but CORS is only warned about, because
 * the consequences differ. A missing user pool means tokens cannot be verified,
 * and the only safe behaviors are to reject every request or to refuse to
 * start — refusing to start is the clearer signal. A missing CORS allowlist
 * merely blocks browser callers.
 *
 * @throws {Error} listing every missing variable at once, rather than one per
 * restart.
 */
export function validateConfig(config: AppConfig): void {
  const missing: string[] = [];

  if (config.auth.userPoolId.trim() === '') {
    missing.push('COGNITO_USER_POOL_ID');
  }
  if (config.auth.clientId.trim() === '') {
    missing.push('COGNITO_CLIENT_ID');
  }
  if (!Number.isInteger(config.port) || config.port <= 0) {
    missing.push('PORT (must be a positive integer)');
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing or invalid required configuration: ${missing.join(', ')}. ` +
        'See .env.example. Refusing to start rather than accepting requests ' +
        'that cannot be authenticated.',
    );
  }
}
