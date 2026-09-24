import type {
  ChatEvent,
  DocumentContent,
  RetrievalCapabilities,
  SearchPage,
  SearchQuery,
} from '@domain';

import { readSse } from './sse.ts';

/**
 * Typed client for the backend API.
 *
 * Request and response shapes come from the backend's domain model via the `@domain`
 * alias, so there is exactly one definition of the wire contract. Hand-mirrored wire
 * shapes drift, and the failure is a UI reading a field the API has stopped sending.
 */

/**
 * `GET /knowledgebase/sources` is not called from the UI.
 *
 * The endpoint remains available to operators and reports `hasUnfilteredSources`, for
 * anyone configuring data sources. `make acl-check` is the operator-facing view for
 * per-document access.
 */

/**
 * Identifies a document to fetch. Both values come from a {@link SearchHit}.
 *
 * Note the absence of anything identifying the user. Access is decided server-side
 * from the verified token, and the API rejects a body carrying `userId` or similar
 * rather than ignoring it.
 */
export interface DocumentContentRequest {
  readonly documentId: string;
  readonly dataSourceId: string;
}

export interface ChatTurnRequest {
  readonly message: string;
  readonly conversationId?: string;
  readonly sourceIds?: readonly string[];
}

/** Raised when the API answers with a non-2xx status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Raised when a chat stream ends without completing.
 *
 * A distinct type because the answer text received so far is still useful — a caller
 * can show it while making clear the answer is incomplete. Silently treating this as
 * success is the specific bug the type exists to prevent.
 */
export class ChatStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatStreamError';
  }
}

export interface ApiClientOptions {
  readonly baseUrl: string;

  /**
   * Supplies the current bearer token.
   *
   * A function rather than a value so a refreshed token is picked up without
   * reconstructing the client, and so no token is captured in a long-lived closure.
   * Returning `undefined` sends the request unauthenticated, which the API rejects —
   * that is deliberate, since the alternative is a client that appears to work while
   * signed out.
   */
  readonly getToken: () => string | undefined;
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  search(query: SearchQuery, signal?: AbortSignal): Promise<SearchPage> {
    return this.post<SearchPage>('/search', query, signal);
  }

  capabilities(signal?: AbortSignal): Promise<RetrievalCapabilities> {
    return this.get<RetrievalCapabilities>('/knowledgebase/capabilities', signal);
  }

  /**
   * Resolves a search result to a short-lived URL for the document itself.
   *
   * Two steps rather than one, because the second step does not go through this API:
   * the URL points at storage and is fetched directly. That is why {@link documentText}
   * exists separately, and why nothing here caches the descriptor — it expires.
   *
   * A `404` means the document is unavailable, which covers both "does not exist" and
   * "you may not read it". The API deliberately does not say which, so neither does
   * this client.
   */
  documentContent(
    request: DocumentContentRequest,
    signal?: AbortSignal,
  ): Promise<DocumentContent> {
    return this.post<DocumentContent>('/documents/content', request, signal);
  }

  /**
   * Fetches the document body from a URL obtained via {@link documentContent}.
   *
   * Deliberately does **not** send the app's bearer token: the URL carries its own
   * pre-authorization and is not an endpoint of this API. Attaching our token to an
   * outbound request to storage would leak it to a different origin.
   */
  async documentText(url: string, signal?: AbortSignal): Promise<string> {
    const response = await fetch(url, signal === undefined ? {} : { signal });
    if (!response.ok) {
      // Most likely an expired URL. The caller can retry from `documentContent`,
      // which mints a fresh one after re-checking access.
      throw new ApiError(response.status, 'The document could not be downloaded.');
    }
    return await response.text();
  }

  /**
   * Streams a chat answer.
   *
   * Yields the same {@link ChatEvent} union the backend's domain model defines, so the
   * view layer switches on `kind` exhaustively and a new event kind becomes a compile
   * error rather than something silently ignored.
   *
   * @throws {ChatStreamError} if the stream reports an error or ends without a
   * completion event. Events yielded before that point are still valid.
   */
  async *chat(
    request: ChatTurnRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const response = await fetch(`${this.options.baseUrl}/chat`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throw new ApiError(response.status, await errorMessage(response));
    }

    let completed = false;

    for await (const frame of readSse(response)) {
      if (frame.event === 'done') {
        completed = true;
        break;
      }

      if (frame.event === 'error') {
        throw new ChatStreamError(parseErrorFrame(frame.data));
      }

      yield JSON.parse(frame.data) as ChatEvent;
    }

    if (!completed) {
      // The server sends an explicit completion event precisely so this case is
      // detectable. Without the check, a connection dropped mid-answer is
      // indistinguishable from a finished one, and the UI presents a truncated answer
      // as complete.
      throw new ChatStreamError(
        'The response stream closed early, so some details may be missing. Try asking again.',
      );
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const token = this.options.getToken();
    return {
      ...extra,
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    };
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.options.baseUrl}${path}`, {
      headers: this.headers(),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
    return (await response.json()) as T;
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.options.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
    return (await response.json()) as T;
  }
}

/**
 * Extracts a displayable message from an error response.
 *
 * The API returns opaque messages by design, so this passes them through rather than
 * interpreting them. Falls back to the status text when the body is not the expected
 * shape, which happens for infrastructure-level errors that never reached the
 * application.
 */
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message.length > 0)
      return body.message;
  } catch {
    // Not JSON. Fall through.
  }
  return `Request failed with status ${String(response.status)}.`;
}

function parseErrorFrame(data: string): string {
  try {
    const parsed = JSON.parse(data) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.length > 0) {
      return parsed.message;
    }
  } catch {
    // Fall through to the generic message.
  }
  return 'The answer could not be completed.';
}
