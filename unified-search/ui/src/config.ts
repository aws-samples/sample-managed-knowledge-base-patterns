/**
 * Frontend configuration, read from Vite environment variables at build time.
 *
 * No values are committed; configuration comes from the environment at build time. See
 * `.env.example`.
 *
 * Everything here is public by nature: a browser app cannot hold a secret, and the
 * Cognito client ID is visible in every authorization redirect. There is deliberately no
 * client secret, because this is a public OAuth client using PKCE.
 */
export interface UiConfig {
  readonly apiBaseUrl: string;
  readonly auth: {
    /** Cognito hosted UI domain, without a scheme. */
    readonly domain: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly logoutUri: string;
  };
}

function required(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env.local and set it.`,
    );
  }
  return value.trim();
}

/**
 * Loads and validates configuration, failing fast on anything missing.
 *
 * Throwing at startup rather than at first use: a missing identity provider domain
 * otherwise surfaces as a failed redirect at the moment a user tries to sign in, which
 * is both later and harder to attribute.
 */
export function loadConfig(env: ImportMetaEnv = import.meta.env): UiConfig {
  // Derived from the current origin rather than configured, so a deployment behind a
  // different hostname needs no rebuild and the two URLs cannot drift out of agreement
  // with each other. They must still be registered on the Cognito app client.
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return {
    apiBaseUrl: required('VITE_API_BASE_URL', env.VITE_API_BASE_URL).replace(/\/$/, ''),
    auth: {
      domain: required('VITE_COGNITO_DOMAIN', env.VITE_COGNITO_DOMAIN).replace(
        /^https?:\/\//,
        '',
      ),
      clientId: required('VITE_COGNITO_CLIENT_ID', env.VITE_COGNITO_CLIENT_ID),
      redirectUri: `${origin}/callback`,
      logoutUri: `${origin}/`,
    },
  };
}
