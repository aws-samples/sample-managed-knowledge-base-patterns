import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginSignIn,
  canResumeSession,
  completeSignIn,
  markResumeAttempted,
  signOutUrl,
} from './oidc.ts';
import { clearToken, getToken } from './token-store.ts';

const CONFIG = {
  domain: 'example.auth.us-east-1.amazoncognito.com',
  clientId: 'client-123',
  redirectUri: 'http://localhost:5173/callback',
  logoutUri: 'http://localhost:5173/',
};

/** A structurally valid JWT with the given expiry. Never verified locally. */
function idToken(expSeconds: number, email = 'alejandro_rosalez@example.com'): string {
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp: expSeconds, email, token_use: 'id' }));
  return `${header}.${payload}.signature-not-checked-here`;
}

const IN_AN_HOUR = () => Math.floor(Date.now() / 1000) + 3600;

let assigned: string | undefined;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  clearToken();
  assigned = undefined;

  vi.stubGlobal('location', {
    ...window.location,
    search: '',
    pathname: '/search',
    assign: (url: string) => {
      assigned = url;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('beginSignIn', () => {
  it('redirects to the hosted UI with PKCE parameters', async () => {
    await beginSignIn(CONFIG);

    expect(assigned).toBeDefined();
    const url = new URL(assigned!);

    expect(url.origin).toBe(`https://${CONFIG.domain}`);
    expect(url.pathname).toBe('/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CONFIG.clientId);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('requests the openid and email scopes', async () => {
    await beginSignIn(CONFIG);
    const scope = new URL(assigned!).searchParams.get('scope') ?? '';

    // `email` is the ACL join key: a token without it can't be matched to document
    // permissions.
    expect(scope.split(' ')).toContain('openid');
    expect(scope.split(' ')).toContain('email');
  });

  it('never uses the deprecated implicit flow', async () => {
    await beginSignIn(CONFIG);

    // `response_type=token` would return the token in the URL fragment, putting it in
    // browser history.
    expect(new URL(assigned!).searchParams.get('response_type')).not.toContain('token');
  });

  it('keeps the verifier out of localStorage', async () => {
    await beginSignIn(CONFIG);

    expect(sessionStorage.getItem('unified-search.pkce.verifier')).toBeTruthy();
    expect(Object.keys(localStorage)).toHaveLength(0);
  });

  it('generates a fresh challenge for every request', async () => {
    await beginSignIn(CONFIG);
    const first = new URL(assigned!).searchParams.get('code_challenge');
    await beginSignIn(CONFIG);
    const second = new URL(assigned!).searchParams.get('code_challenge');

    // Reuse would allow an observed challenge to be replayed.
    expect(first).not.toBe(second);
  });
});

describe('completeSignIn', () => {
  /** Puts this tab in the state `beginSignIn` would have left it in. */
  async function startFlow(): Promise<{ state: string }> {
    await beginSignIn(CONFIG);
    return { state: new URL(assigned!).searchParams.get('state')! };
  }

  function tokenEndpointReturns(payload: unknown, status = 200): void {
    vi.stubGlobal('fetch', (() =>
      Promise.resolve(
        new Response(JSON.stringify(payload), { status }),
      )) as typeof fetch);
  }

  it('returns undefined when the URL is not a callback', async () => {
    await expect(completeSignIn(CONFIG, '')).resolves.toBeUndefined();
  });

  it('exchanges the code and stores the token in memory', async () => {
    const { state } = await startFlow();
    const token = idToken(IN_AN_HOUR());
    tokenEndpointReturns({ id_token: token });

    const result = await completeSignIn(CONFIG, `?code=abc&state=${state}`);

    expect(result?.returnTo).toBe('/search');
    expect(getToken()).toBe(token);
    // The whole point: nothing persisted.
    expect(Object.keys(localStorage)).toHaveLength(0);
    expect(Object.keys(sessionStorage)).toHaveLength(0);
  });

  it('sends the verifier and no client secret', async () => {
    const { state } = await startFlow();
    const verifier = sessionStorage.getItem('unified-search.pkce.verifier');
    let sentBody = '';
    vi.stubGlobal('fetch', ((_url: string, init?: RequestInit) => {
      sentBody = String(init?.body ?? '');
      return Promise.resolve(
        new Response(JSON.stringify({ id_token: idToken(IN_AN_HOUR()) }), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch);

    await completeSignIn(CONFIG, `?code=abc&state=${state}`);

    const sent = new URLSearchParams(sentBody);
    expect(sent.get('code_verifier')).toBe(verifier);
    expect(sent.get('grant_type')).toBe('authorization_code');
    // A browser app is a public client and cannot hold a secret.
    expect(sent.get('client_secret')).toBeNull();
  });

  /**
   * `state` proves the callback belongs to an authorization request this tab started.
   * Without the check, an attacker can complete a sign-in in the victim's browser.
   */
  it('rejects a callback whose state does not match', async () => {
    await startFlow();
    tokenEndpointReturns({ id_token: idToken(IN_AN_HOUR()) });

    await expect(
      completeSignIn(CONFIG, '?code=abc&state=not-the-state'),
    ).rejects.toThrow(/could not be verified/);
    expect(getToken()).toBeUndefined();
  });

  it('rejects a callback when this tab never started a flow', async () => {
    tokenEndpointReturns({ id_token: idToken(IN_AN_HOUR()) });

    await expect(completeSignIn(CONFIG, '?code=abc&state=whatever')).rejects.toThrow(
      /no record of starting it/,
    );
    expect(getToken()).toBeUndefined();
  });

  it('consumes the verifier so a failed attempt cannot be retried against it', async () => {
    const { state } = await startFlow();
    tokenEndpointReturns({}, 400);

    await expect(completeSignIn(CONFIG, `?code=abc&state=${state}`)).rejects.toThrow();

    expect(sessionStorage.getItem('unified-search.pkce.verifier')).toBeNull();
    // A second attempt now fails on the missing verifier rather than reusing it.
    await expect(completeSignIn(CONFIG, `?code=abc&state=${state}`)).rejects.toThrow(
      /no record of starting it/,
    );
  });

  it('surfaces an error returned by the identity provider', async () => {
    await startFlow();

    await expect(
      completeSignIn(CONFIG, '?error=access_denied&error_description=User+canceled'),
    ).rejects.toThrow(/User canceled/);
  });

  it('rejects a response with no ID token', async () => {
    const { state } = await startFlow();
    // An access token carries no email claim and is issued under different consent
    // semantics, so it must not stand in for one.
    tokenEndpointReturns({ access_token: 'not-an-id-token' });

    await expect(completeSignIn(CONFIG, `?code=abc&state=${state}`)).rejects.toThrow(
      /no ID token/,
    );
    expect(getToken()).toBeUndefined();
  });

  it('rejects a token with no usable expiry', async () => {
    const { state } = await startFlow();
    const header = btoa(JSON.stringify({ alg: 'RS256' }));
    const payload = btoa(JSON.stringify({ email: 'alejandro_rosalez@example.com' }));
    tokenEndpointReturns({ id_token: `${header}.${payload}.sig` });

    await expect(completeSignIn(CONFIG, `?code=abc&state=${state}`)).rejects.toThrow(
      /no usable expiry/,
    );
  });

  it('does not store an already-expired token as usable', async () => {
    const { state } = await startFlow();
    tokenEndpointReturns({ id_token: idToken(Math.floor(Date.now() / 1000) - 60) });

    await completeSignIn(CONFIG, `?code=abc&state=${state}`);

    // Stored, but the store refuses to hand out an expired token.
    expect(getToken()).toBeUndefined();
  });
});

/**
 * Resuming a session without asking.
 *
 * Tokens live in memory only, so every reload starts signed out even while the identity
 * provider still has a session. Without an automatic attempt, a refresh means clicking
 * "Sign in" again to get back to where you already were, which during a demo is every
 * reload. With one, the reload is a redirect the user barely notices.
 *
 * The risk is a loop, so the attempt is recorded before leaving and only cleared once a
 * token is actually in hand.
 */
describe('resuming a session', () => {
  it('is worth attempting on a fresh tab', () => {
    expect(canResumeSession()).toBe(true);
  });

  it('is attempted at most once per tab', () => {
    markResumeAttempted();

    // A provider that bounces back without a code would otherwise redirect forever.
    expect(canResumeSession()).toBe(false);
  });

  it('becomes available again once a sign-in succeeds', async () => {
    markResumeAttempted();
    await beginSignIn(CONFIG);
    const state = new URL(assigned ?? '').searchParams.get('state') ?? '';
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ id_token: idToken(IN_AN_HOUR()) }), {
          status: 200,
        }),
      ),
    );

    await completeSignIn(CONFIG, `?code=abc&state=${state}`);

    // A session exists again, so the next reload may resume from it.
    expect(canResumeSession()).toBe(true);
  });
});

describe('signOutUrl', () => {
  it('signs out at the identity provider, not just locally', () => {
    const url = new URL(signOutUrl(CONFIG));

    // Dropping only the local token would leave the Cognito session cookie intact, so
    // the next sign-in completes silently and the user appears never to have logged out.
    expect(url.origin).toBe(`https://${CONFIG.domain}`);
    expect(url.pathname).toBe('/logout');
    expect(url.searchParams.get('client_id')).toBe(CONFIG.clientId);
    expect(url.searchParams.get('logout_uri')).toBe(CONFIG.logoutUri);
  });
});
