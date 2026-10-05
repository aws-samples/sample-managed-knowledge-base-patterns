import { useEffect, useRef, useState } from 'react';
import { getEmbeddingContext } from './embedding.ts';

interface DemoUser {
  key: string;
  label: string;
}

interface EmbedUrlResponse {
  embedUrl?: string;
  fixedAgentId?: string | null;
  error?: string;
}

/**
 * A deliberately thin application shell. All of the retrieval, generation, citation and
 * conversation-history behavior lives in the embedded Amazon Quick chat agent, which is
 * in turn backed by the Bedrock managed knowledge base provisioned in ../infra.
 *
 * The user switcher exists to demonstrate document-level access control: both users query
 * the same knowledge base, but Quick forwards each user's identity to Bedrock, which
 * filters retrieval results against the ACLs in the S3 data source. User A can see the
 * finance document, user B can see the engineering runbook, and both can see the shared
 * travel policy.
 */
export default function App() {
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load the available demo identities. The server returns labels only; the underlying
  // Quick user ARNs never leave the harness.
  useEffect(() => {
    let cancelled = false;

    fetch('/api/users')
      .then((r) =>
        r.ok
          ? (r.json() as Promise<DemoUser[]>)
          : Promise.reject(new Error(`/api/users returned ${r.status}`)),
      )
      .then((list) => {
        if (cancelled) return;
        setUsers(list);
        setSelected(list[0]?.key ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(`${message}. Is the harness running? Try: npm run dev:api`);
        setBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Mint an embed URL for the selected identity and mount the chat experience.
  useEffect(() => {
    const container = containerRef.current;
    if (!selected || !container) return;

    let cancelled = false;

    // Tear down any previously mounted chat iframe before embedding again. This also
    // makes the effect safe under React StrictMode's double invocation in development.
    // The SDK's hidden control iframe lives outside this container and is shared; see
    // embedding.ts.
    container.replaceChildren();
    setBusy(true);
    setError(null);

    void (async () => {
      try {
        const response = await fetch('/api/embed-url', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user: selected }),
        });

        const payload = (await response.json()) as EmbedUrlResponse;
        if (!response.ok || !payload.embedUrl) {
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        if (cancelled) return;

        const context = await getEmbeddingContext();
        if (cancelled) return;

        await context.embedQuickChat(
          {
            url: payload.embedUrl,
            container,
            width: '100%',
            height: '100%',
          },
          // agentOptions.fixedAgentId locks the chat to one agent. Omitted when the
          // harness has no QUICK_FIXED_AGENT_ID configured, which lets the user choose.
          payload.fixedAgentId
            ? { agentOptions: { fixedAgentId: payload.fixedAgentId } }
            : undefined,
        );

        if (!cancelled) setBusy(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setBusy(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selected]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>Example Corp Assistant</span>
        </div>

        <div className="identity" role="group" aria-label="Demo identity">
          <span className="identity-label">Signed in as</span>
          {users.map((user) => (
            <button
              key={user.key}
              type="button"
              className={user.key === selected ? 'chip chip-active' : 'chip'}
              aria-pressed={user.key === selected}
              onClick={() => setSelected(user.key)}
            >
              {user.label}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      {busy && !error && (
        <div className="banner" role="status">
          Starting session…
        </div>
      )}

      <main className="chat-surface">
        <div ref={containerRef} className="chat-frame" />
      </main>
    </div>
  );
}
