/**
 * Where the ID token lives, and — more importantly — where it does not.
 *
 * **In memory only.** Not `localStorage`, not `sessionStorage`, not a cookie readable by
 * script. A token in `localStorage` is readable by any script that ends up on the page,
 * so a single compromised dependency turns into every signed-in user's identity, and it
 * survives tab closure so it keeps being stealable long after the user walked away.
 *
 * ## What that costs, stated plainly
 *
 * A full page reload loses the token and triggers a fresh authorization redirect.
 * Because Cognito keeps its own session cookie, that redirect is usually invisible —
 * the user is bounced to the hosted UI and straight back. But it *is* a redirect, and on
 * a slow connection it is perceptible.
 *
 * The usual fix is a refresh token, which would have to be persisted somewhere to be
 * useful — putting us back where we started, with a longer-lived credential. For a
 * sample the simpler trade is to accept the redirect. A production system should reach
 * for a backend-for-frontend holding the refresh token in an HttpOnly cookie, which is a
 * different architecture rather than a bigger `localStorage` key.
 */

export interface StoredToken {
  readonly idToken: string;
  /** Absolute expiry, milliseconds since the epoch. */
  readonly expiresAt: number;
}

let current: StoredToken | undefined;

/**
 * Treat a token as expired slightly early, so a request is not sent with a token that
 * expires in flight.
 */
const EXPIRY_SKEW_MS = 30_000;

export function setToken(token: StoredToken): void {
  current = token;
}

/**
 * The current token, or `undefined` if absent or expiring imminently.
 *
 * Returning `undefined` for a nearly-expired token rather than handing it out means the
 * caller re-authenticates instead of making a request that fails for a reason it cannot
 * distinguish from a permissions problem.
 */
export function getToken(): string | undefined {
  if (current === undefined) return undefined;
  if (Date.now() >= current.expiresAt - EXPIRY_SKEW_MS) {
    current = undefined;
    return undefined;
  }
  return current.idToken;
}

export function clearToken(): void {
  current = undefined;
}

/**
 * Reads the `exp` claim to determine expiry.
 *
 * **This is not verification.** The signature is not checked and must not be: the
 * backend verifies every token on every request, and that is the only check that
 * counts. This decodes one claim to decide when to stop using a token locally, which is
 * a user-experience decision, not a security one.
 *
 * Worth being explicit about, because the same decode on a server, treated as
 * authorization, is the failure this project is built to avoid.
 */
export function readExpiry(idToken: string): number | undefined {
  const payload = idToken.split('.')[1];
  if (payload === undefined) return undefined;

  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as { exp?: unknown };
    if (typeof claims.exp !== 'number') return undefined;
    return claims.exp * 1000;
  } catch {
    return undefined;
  }
}
