import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { UiConfig } from '../config.ts';
import { AuthContext, type AuthState, type AuthStatus } from './auth-context.ts';
import {
  beginSignIn,
  canResumeSession,
  completeSignIn,
  markResumeAttempted,
  signOutUrl,
} from './oidc.ts';
import { clearToken, getToken } from './token-store.ts';

/**
 * The single source of authentication state for the application.
 *
 * A single implementation owns token storage and clearing, so there's one source of truth.
 *
 * There is no bypass and no placeholder identity. The backend enforces the same rule with
 * a test that scans its own source, because a bypass is easy to add and invisible once
 * added.
 */

export interface AuthProviderProps {
  readonly config: UiConfig;
  readonly children: ReactNode;
  /** Called with the path to return to after a successful sign-in. */
  readonly onSignedIn?: (returnTo: string) => void;
}

export function AuthProvider({
  config,
  children,
  onSignedIn,
}: AuthProviderProps): ReactNode {
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [email, setEmail] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  // React runs effects twice in development's strict mode, and an authorization code is
  // single-use — a second exchange fails and would surface as a spurious sign-in error.
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    void (async () => {
      try {
        const result = await completeSignIn(config.auth);

        if (result !== undefined) {
          setEmail(emailFromToken(getToken()));
          setStatus('signed-in');
          onSignedIn?.(result.returnTo);
          return;
        }

        // Not a callback. A token exists only if this page was not reloaded, since
        // tokens are held in memory alone.
        const existing = getToken();
        if (existing !== undefined) {
          setEmail(emailFromToken(existing));
          setStatus('signed-in');
          return;
        }

        // Try to resume without asking. Holding the token in memory means every reload
        // starts signed out, but the identity provider usually still has a session, in which
        // case this returns a code with no login form and the reload is close to invisible.
        // Attempted once per tab, so a provider that bounces us back without a code cannot
        // produce a redirect loop.
        if (canResumeSession()) {
          markResumeAttempted();
          await beginSignIn(config.auth);
          return;
        }

        setStatus('signed-out');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Sign-in failed.');
        setStatus('error');
      }
    })();
  }, [config.auth, onSignedIn]);

  const signIn = useCallback(() => {
    setError(undefined);
    void beginSignIn(config.auth).catch((caught: unknown) => {
      setError(
        caught instanceof Error ? caught.message : 'Sign-in could not be started.',
      );
      setStatus('error');
    });
  }, [config.auth]);

  const signOut = useCallback(() => {
    // Clear locally *and* end the session at the identity provider. Clearing only the
    // local token would leave the Cognito session cookie intact, so the next sign-in
    // completes silently and the user appears never to have logged out.
    clearToken();
    setEmail(undefined);
    setStatus('signed-out');
    // Blocks the automatic resume above. Signing out and being silently signed back in on
    // the next load would make the button look broken.
    markResumeAttempted();
    window.location.assign(signOutUrl(config.auth));
  }, [config.auth]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      ...(email === undefined ? {} : { email }),
      ...(error === undefined ? {} : { error }),
      signIn,
      signOut,
      getToken,
    }),
    [status, email, error, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Reads the email claim for display.
 *
 * Decodes without verifying, which is correct here and would not be on a server: this
 * value only ever reaches a header in the UI. The same decode on a server, treated as
 * authorization, is the failure this project is built to avoid.
 */
function emailFromToken(token: string | undefined): string | undefined {
  const payload = token?.split('.')[1];
  if (payload === undefined) return undefined;

  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      email?: unknown;
    };
    return typeof claims.email === 'string' ? claims.email : undefined;
  } catch {
    return undefined;
  }
}
