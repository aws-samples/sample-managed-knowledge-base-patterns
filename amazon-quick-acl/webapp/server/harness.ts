/**
 * Request handling for the local harness that mints Amazon Quick embed URLs.
 *
 * WHY THIS IS A LOCAL SCRIPT AND NOT A DEPLOYED ENDPOINT
 * ------------------------------------------------------
 * Generating an embed URL requires AWS credentials and, critically, the caller chooses
 * which Amazon Quick user the URL is minted for (`UserArn`). An endpoint that accepts a
 * user identity from its caller and is not itself authenticated would let anyone request
 * a session as any Quick user - and because Quick forwards that identity to Bedrock for
 * ACL filtering, that is also a document-level access control bypass.
 *
 * This harness therefore:
 *   - binds to 127.0.0.1 and runs against your own AWS credentials,
 *   - accepts only an opaque selector ("a" or "b") that it maps to a pre-configured ARN,
 *     so even locally the client cannot name an arbitrary identity,
 *   - rejects requests whose Host header is not the loopback address it listens on, so a
 *     DNS-rebinding page cannot reach it under another name and read an embed URL (which
 *     is a bearer credential), and
 *   - rejects cross-origin requests and non-JSON POST bodies, so a page on another origin
 *     cannot drive it with a "simple" form or text/plain request.
 *
 * To productionize: replace this with a backend that authenticates the end user through
 * your identity provider and derives `UserArn` from the *verified* session - never from
 * request input. See the README section "Productionizing the embed endpoint".
 */

import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { HarnessConfig } from './config.ts';

/** Mints an embed URL for one Quick user. Injected so tests need no AWS access. */
export type EmbedUrlMinter = (userArn: string) => Promise<string>;

export type Logger = (message: string) => void;

const MAX_BODY_BYTES = 4096;

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    // The browser only ever talks to this through the Vite dev proxy (same origin), so
    // no CORS headers are sent. Keeping it that way avoids widening access.
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new RequestError(413, 'Request body too large');

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new RequestError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'Request body is not valid JSON');
  }
}

function isJsonContentType(header: string | undefined): boolean {
  return header?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

export function createHarnessHandler(
  config: HarnessConfig,
  mintEmbedUrl: EmbedUrlMinter,
  log: Logger = () => {},
): RequestListener {
  const allowedHosts = new Set([
    `127.0.0.1:${config.port}`,
    `localhost:${config.port}`,
  ]);
  const selectors = [...config.users.keys()].join(', ');

  return async (req, res) => {
    // Host check first, before anything is read or routed. A DNS-rebinding attack
    // reaches this port under an attacker-controlled name, and the Host header is the
    // one thing that name cannot hide. The Vite proxy rewrites Host to the target
    // (changeOrigin in vite.config.ts), so legitimate traffic always matches.
    if (!allowedHosts.has(req.headers.host ?? '')) {
      return json(res, 403, { error: 'Forbidden' });
    }

    // Browsers attach Origin to cross-origin requests and to same-origin POSTs. Absent
    // is fine (curl, same-origin GET); present and different is a foreign page.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== config.allowedDomain) {
      return json(res, 403, { error: 'Forbidden' });
    }

    // Compare on the pathname rather than the raw URL so a query string or a proxy that
    // forwards an absolute URI does not fall through to the 404.
    const { pathname } = new URL(req.url ?? '/', `http://127.0.0.1:${config.port}`);

    if (req.method === 'GET' && pathname === '/api/users') {
      // Labels only - the ARNs stay server side.
      return json(
        res,
        200,
        [...config.users.entries()].map(([key, u]) => ({ key, label: u.label })),
      );
    }

    if (req.method === 'POST' && pathname === '/api/embed-url') {
      // application/json is not a CORS-safelisted content type, so a cross-origin page
      // cannot send it without a preflight this server never answers.
      if (!isJsonContentType(req.headers['content-type'])) {
        return json(res, 415, { error: 'Content-Type must be application/json' });
      }

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const status = err instanceof RequestError ? err.status : 400;
        const message = err instanceof RequestError ? err.message : 'Bad request';
        return json(res, status, { error: message });
      }

      const selector =
        typeof body === 'object' && body !== null && 'user' in body
          ? (body as { user: unknown }).user
          : undefined;
      const user =
        typeof selector === 'string' ? config.users.get(selector) : undefined;
      if (!user) {
        return json(res, 400, {
          error: `Unknown user selector. Expected one of: ${selectors}`,
        });
      }

      try {
        const embedUrl = await mintEmbedUrl(user.arn);
        return json(res, 200, { embedUrl, fixedAgentId: config.fixedAgentId });
      } catch (err) {
        // Full detail to the terminal, which the developer can read; a generic message
        // to the browser, which should not see raw AWS errors or the ARNs they contain.
        const name = err instanceof Error ? err.name : 'Error';
        const message = err instanceof Error ? err.message : String(err);
        log(`GenerateEmbedUrlForRegisteredUser failed: ${name}: ${message}`);
        return json(res, 502, {
          error:
            'Amazon Quick did not return an embed URL. See the harness terminal for details.',
        });
      }
    }

    return json(res, 404, { error: 'Not found' });
  };
}
