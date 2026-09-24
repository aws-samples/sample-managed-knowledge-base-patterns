import { createPkcePair, createState } from './pkce.ts';
import { readExpiry, setToken } from './token-store.ts';

/**
 * Authorization Code with PKCE against the Amazon Cognito hosted UI.
 *
 * A single implementation owns token storage and clearing, so there's one source of truth.
 *
 * There is no bypass, no development shortcut, and no placeholder identity. A dev-only
 * bypass is indistinguishable from a real one once it ships.
 */

export interface OidcConfig {
  /** Cognito hosted UI domain, e.g. `my-app.auth.us-east-1.amazoncognito.com`. */
  readonly domain: string;
  readonly clientId: string;
  /** Must exactly match a callback URL configured on the app client. */
  readonly redirectUri: string;
  /** Where Cognito returns the user after sign-out. */
  readonly logoutUri: string;
}

/**
 * Keys for the short-lived values that must survive the redirect.
 *
 * `sessionStorage`, not `localStorage`: these are single-use, scoped to one tab, and
 * cleared the moment the callback is handled. Note the distinction from the token
 * itself, which is never persisted anywhere — a PKCE verifier is useless without the
 * matching authorization code, whereas a token is a bearer credential.
 */
const VERIFIER_KEY = 'unified-search.pkce.verifier';
const STATE_KEY = 'unified-search.pkce.state';
const RETURN_TO_KEY = 'unified-search.returnTo';

/**
 * Marks that this tab has already tried to resume a session without being asked.
 *
 * Guards against a redirect loop. If the identity provider bounces us straight back without
 * a code, a second automatic attempt would do the same thing forever, so the attempt is
 * recorded before leaving and only cleared once a token is in hand.
 */
const RESUMED_KEY = 'unified-search.resumeAttempted';

/**
 * Whether an automatic attempt to resume the session is still worth making.
 *
 * Tokens live in memory only, so every reload starts signed out even when the identity
 * provider still considers the user signed in. Cognito keeps its own session cookie, so
 * `/oauth2/authorize` returns a code without showing a login form in that case, and the
 * reload becomes a redirect the user barely sees. Without this, a refresh means clicking
 * "Sign in" again to reach the same place, which during a demo happens on every reload.
 */
export function canResumeSession(): boolean {
  try {
    return sessionStorage.getItem(RESUMED_KEY) === null;
  } catch {
    return false;
  }
}

/** Records an automatic resume attempt, so it happens at most once per tab. */
export function markResumeAttempted(): void {
  try {
    sessionStorage.setItem(RESUMED_KEY, '1');
  } catch {
    // Without storage the attempt cannot be recorded, so resuming is skipped entirely
    // rather than risking a loop.
  }
}

function clearResumeAttempt(): void {
  try {
    sessionStorage.removeItem(RESUMED_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/** Sends the browser to the hosted UI to sign in. */
export async function beginSignIn(config: OidcConfig): Promise<void> {
  const { verifier, challenge } = await createPkcePair();
  const state = createState();

  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  // Return the user to where they were, not always to the landing page.
  sessionStorage.setItem(
    RETURN_TO_KEY,
    window.location.pathname + window.location.search,
  );

  const url = new URL(`https://${config.domain}/oauth2/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  // `openid` yields the ID token, which is what the backend verifies. `email` is the
  // ACL join key, so a token without it can't be matched to document permissions.
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  window.location.assign(url.toString());
}

export interface CallbackResult {
  /** Path the user was on before signing in. */
  readonly returnTo: string;
}

/**
 * Completes the flow when the browser returns from the hosted UI.
 *
 * @returns `undefined` when the current URL is not an authorization callback, so this
 * can be called unconditionally on startup.
 * @throws {Error} when the callback is malformed, the state does not match, or the token
 * exchange fails.
 */
export async function completeSignIn(
  config: OidcConfig,
  search: string = window.location.search,
): Promise<CallbackResult | undefined> {
  const params = new URLSearchParams(search);
  const code = params.get('code');
  const returnedState = params.get('state');
  const error = params.get('error');

  if (error !== null) {
    clearFlowState();
    throw new Error(`Sign-in failed: ${params.get('error_description') ?? error}`);
  }

  if (code === null) return undefined;

  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const returnTo = sessionStorage.getItem(RETURN_TO_KEY) ?? '/';

  // Consume the single-use values before doing anything that can fail, so a failed
  // attempt cannot be retried against the same verifier.
  clearFlowState();

  if (expectedState === null || verifier === null) {
    throw new Error(
      'Sign-in could not be completed because this tab has no record of starting it. ' +
        'This happens if the callback URL is opened directly. Try signing in again.',
    );
  }

  if (returnedState !== expectedState) {
    // A mismatched state means this callback does not belong to the request this tab
    // started, which is the CSRF case `state` exists to catch.
    throw new Error('Sign-in could not be verified. Please try again.');
  }

  const idToken = await exchangeCode(config, code, verifier);
  const expiresAt = readExpiry(idToken);

  if (expiresAt === undefined) {
    throw new Error('The identity provider returned a token with no usable expiry.');
  }

  setToken({ idToken, expiresAt });
  // A session exists again, so the next reload may try to resume without being asked.
  clearResumeAttempt();
  return { returnTo };
}

/**
 * Signs out at the identity provider, not merely locally.
 *
 * Dropping the local token would leave the Cognito session cookie intact, so the next
 * sign-in would complete silently and the user would appear never to have logged out.
 */
export function signOutUrl(config: OidcConfig): string {
  const url = new URL(`https://${config.domain}/logout`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('logout_uri', config.logoutUri);
  return url.toString();
}

async function exchangeCode(
  config: OidcConfig,
  code: string,
  verifier: string,
): Promise<string> {
  // No client secret: a browser app is a public client and cannot hold one. PKCE is
  // what authenticates this exchange.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });

  const response = await fetch(`https://${config.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed with status ${String(response.status)}.`);
  }

  const payload = (await response.json()) as { id_token?: unknown };
  if (typeof payload.id_token !== 'string' || payload.id_token.length === 0) {
    // The access token is deliberately ignored: the backend verifies ID tokens, which
    // carry the email claim.
    throw new Error('The identity provider returned no ID token.');
  }

  return payload.id_token;
}

function clearFlowState(): void {
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(RETURN_TO_KEY);
}
