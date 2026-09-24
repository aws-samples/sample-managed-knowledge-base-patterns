import { createContext, useContext } from 'react';

/**
 * Authentication state, and the hook that reads it.
 *
 * Separated from `AuthProvider.tsx` so that file exports only a component. Mixing a
 * component export with non-component exports defeats React fast refresh, which then
 * reloads the whole module tree on every edit and loses application state.
 */

export type AuthStatus = 'checking' | 'signed-out' | 'signed-in' | 'error';

export interface AuthState {
  readonly status: AuthStatus;

  /**
   * The signed-in user's email, decoded from the ID token for display only.
   *
   * **Not an authorization input.** The backend derives the identity it filters on from
   * the token it verifies itself, so nothing reported here is trusted by the API.
   */
  readonly email?: string;

  readonly error?: string;

  readonly signIn: () => void;
  readonly signOut: () => void;

  /** Current bearer token, or `undefined`. Read by the API client per request. */
  readonly getToken: () => string | undefined;
}

export const AuthContext = createContext<AuthState | undefined>(undefined);

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used inside <AuthProvider>.');
  }
  return context;
}
