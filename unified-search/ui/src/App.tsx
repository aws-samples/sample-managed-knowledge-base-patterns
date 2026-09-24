import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';

import { ApiClient } from './api/client.ts';
import { useAuth } from './auth/auth-context.ts';
import { AuthProvider } from './auth/AuthProvider.tsx';
import { ChatPage } from './chat/ChatPage.tsx';
import type { UiConfig } from './config.ts';
import { CombinedSearchPage } from './combined/CombinedSearchPage.tsx';
import { DocumentView } from './documents/DocumentView.tsx';
import { useTheme } from './theme/useTheme.ts';
import styles from './App.module.css';

export interface AppProps {
  readonly config: UiConfig;
}

/**
 * Application shell.
 *
 * Every screen sits behind authentication, with no bypass, mock mode, or placeholder
 * identity, so every result on screen comes from a real, permission-filtered query.
 */
export function App({ config }: AppProps): ReactNode {
  const navigate = useNavigate();

  return (
    <AuthProvider
      config={config}
      onSignedIn={(returnTo) => {
        // Replace, so the callback URL with its authorization code is not left in
        // history where a back-navigation would try to redeem a spent code.
        navigate(returnTo === '/callback' ? '/' : returnTo, { replace: true });
      }}
    >
      <Shell config={config} />
    </AuthProvider>
  );
}

function Shell({ config }: { readonly config: UiConfig }): ReactNode {
  const auth = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();

  // Rebuilt only when the base URL changes. `getToken` is read per request, so a
  // refreshed token is picked up without reconstructing the client.
  const api = useMemo(
    () => new ApiClient({ baseUrl: config.apiBaseUrl, getToken: auth.getToken }),
    [config.apiBaseUrl, auth.getToken],
  );

  return (
    <>
      <a className={styles.skipLink} href="#main">
        Skip to main content
      </a>

      <div className={styles.shell}>
        <header className={styles.header}>
          <h1 className={styles.brand}>Unified Search</h1>

          <div className={styles.session}>
            {/* Available signed out too, so the display theme can be chosen before
                signing in. */}
            <button
              className={styles.textButton}
              type="button"
              onClick={toggleTheme}
              aria-pressed={theme === 'dark'}
            >
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>

            {auth.status === 'signed-in' && (
              <>
                {auth.email !== undefined && <span>{auth.email}</span>}
                <button
                  className={styles.textButton}
                  type="button"
                  onClick={auth.signOut}
                >
                  Sign out
                </button>
              </>
            )}
          </div>
        </header>

        {auth.status === 'signed-in' && (
          <nav className={styles.nav} aria-label="Main">
            <ul>
              <li>
                <TabLink to="/">Search</TabLink>
              </li>
              <li>
                <TabLink to="/chat">Chat</TabLink>
              </li>
            </ul>
          </nav>
        )}

        <main id="main">
          {auth.status === 'checking' && <p role="status">Checking your session…</p>}

          {(auth.status === 'signed-out' || auth.status === 'error') && (
            <div className={styles.signIn}>
              {auth.error !== undefined && (
                <p className={styles.error} role="alert">
                  {auth.error}
                </p>
              )}
              <p>
                Sign in to search your organization’s documents. You will only see
                results from documents you have permission to read.
              </p>
              <button className={styles.primary} type="button" onClick={auth.signIn}>
                Sign in
              </button>
            </div>
          )}

          {auth.status === 'signed-in' && <SignedIn api={api} />}
        </main>
      </div>
    </>
  );
}

function TabLink({
  to,
  children,
}: {
  readonly to: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        isActive ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink
      }
    >
      {children}
    </NavLink>
  );
}

/**
 * The authenticated surfaces.
 *
 * Capabilities are fetched once and passed down so chat can state whether it remembers
 * anything. Defaulting to "no memory" while unknown is the safer direction: claiming a
 * conversation continues and then losing it is worse than saying it will not.
 */
function SignedIn({ api }: { readonly api: ApiClient }): ReactNode {
  const [conversationMemory, setConversationMemory] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const capabilities = await api.capabilities(controller.signal);
        setConversationMemory(capabilities.conversationMemory);
      } catch {
        // Non-fatal: search and chat work regardless. Leaving the defaults in place
        // understates capability rather than overstating it.
      }
    })();

    return () => {
      controller.abort();
    };
  }, [api]);

  return (
    <>
      <Routes>
        <Route path="/" element={<CombinedSearchPage api={api} />} />
        {/* The OAuth callback lands here; the provider replaces the URL once the code is
            exchanged, so this only renders for the instant before that happens. */}
        <Route path="/callback" element={<CombinedSearchPage api={api} />} />
        <Route
          path="/chat"
          element={<ChatPage api={api} conversationMemory={conversationMemory} />}
        />
        {/* Not a nav tab: reached by clicking a result, and it needs a document
            reference in the query string to show anything. */}
        <Route path="/document" element={<DocumentView api={api} />} />
        <Route path="*" element={<CombinedSearchPage api={api} />} />
      </Routes>
    </>
  );
}
