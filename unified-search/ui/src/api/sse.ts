/**
 * Reads a Server-Sent Events stream from a `fetch` response.
 *
 * Hand-written rather than using `EventSource`, and that is not a preference — it is
 * forced. `EventSource` cannot send request headers, so it cannot present the bearer
 * token this API authenticates with, and the alternative would be putting an identity
 * token in a query string where it lands in access logs and browser history. So the
 * chat endpoint is a `POST` and the framing is parsed here.
 *
 * ## The two failure modes this exists to get right
 *
 * **Frames split across network chunks.** A `ReadableStream` chunk boundary has nothing
 * to do with a frame boundary, so `data:` for one event routinely arrives in two reads.
 * Parsing per chunk drops or truncates events.
 *
 * **A stream that ends without a completion event has failed.** The server commits to
 * `200` before it knows whether the answer will succeed, so a mid-stream failure
 * arrives as an `error` event rather than an HTTP status. A reader that stops at "the
 * connection closed" renders a truncated answer as a complete one.
 */

/** One parsed frame. `event` defaults to `message` per the SSE spec. */
export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

/**
 * Yields frames from a response body.
 *
 * @throws {Error} if the response has no body, which means the request never
 * established a stream.
 */
export async function* readSse(response: Response): AsyncGenerator<SseFrame> {
  const body = response.body;
  if (body === null) {
    throw new Error('The response carried no body, so no stream was established.');
  }

  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        // A trailing frame with no terminating blank line. Emitting it rather than
        // discarding it, because the alternative loses the final event of any stream
        // whose last write was not newline-terminated.
        const leftover = parseFrame(buffer);
        if (leftover !== undefined) yield leftover;
        return;
      }

      buffer += value;

      // Frames are separated by a blank line. Normalize CRLF first: the spec permits
      // it, and a proxy may rewrite line endings.
      buffer = buffer.replace(/\r\n/g, '\n');

      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const frame = parseFrame(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        if (frame !== undefined) yield frame;
        separator = buffer.indexOf('\n\n');
      }
    }
  } finally {
    // Releasing the lock lets the caller abort without leaving the body locked, which
    // otherwise surfaces later as an unrelated "body already used" error.
    reader.releaseLock();
  }
}

/**
 * Parses one frame's worth of lines.
 *
 * Returns `undefined` for a chunk carrying no `data`, which covers comment-only
 * keep-alive frames (`: ping`) and stray blank space.
 */
function parseFrame(chunk: string): SseFrame | undefined {
  if (chunk.trim().length === 0) return undefined;

  let event = 'message';
  const data: string[] = [];

  for (const line of chunk.split('\n')) {
    if (line.startsWith(':')) continue; // comment / keep-alive
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      // A single leading space after the colon is part of the framing, not the data.
      const value = line.slice('data:'.length);
      data.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }

  if (data.length === 0) return undefined;

  // Multi-line data is joined with newlines, per the spec. This server emits JSON on
  // one line so it does not arise, but a reader that silently dropped continuation
  // lines would corrupt data rather than fail visibly.
  return { event, data: data.join('\n') };
}
