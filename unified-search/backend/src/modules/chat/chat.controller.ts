import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import type { ChatEvent, RetrievalProvider, UserIdentity } from '../../domain/index.js';
import { RETRIEVAL_PROVIDER } from '../../domain/index.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ChatRequestDto } from './chat.dto.js';

/**
 * Streaming RAG chat over the knowledge base.
 *
 * ## Why POST with hand-written SSE rather than Nest's `@Sse()`
 *
 * `@Sse()` is the idiomatic choice and it is a `GET` route, which exists to be consumed
 * by the browser's `EventSource`. That does not work here: **`EventSource` cannot send
 * request headers**, so it cannot present the bearer token this API authenticates
 * with. The only way to authenticate a `GET` SSE endpoint would be to put the token in
 * the query string, and access tokens in URLs end up in access logs, browser history,
 * and referrer headers. That is not a trade worth making for a decorator.
 *
 * So this is a `POST` that writes SSE frames directly. Browser clients consume it with
 * `fetch` and a `ReadableStream` reader, which carries headers normally. The wire
 * format is still Server-Sent Events, so it stays inspectable with `curl -N`.
 *
 * ## Errors after the first byte
 *
 * Once headers are flushed the response is committed to `200`, and a failure can no
 * longer be an HTTP status. Mid-stream failures are therefore reported as an SSE
 * `error` event, and clients must treat a stream that ends without a `done` event as
 * failed. This is worth stating explicitly because the naive client — accumulate
 * `data:` frames until the stream closes — silently renders a truncated answer as a
 * complete one.
 */
@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    @Inject(RETRIEVAL_PROVIDER) private readonly provider: RetrievalProvider,
  ) {}

  // 200, not Nest's default 201 for POST. Nothing was created, and the status is
  // flushed with the headers before any content exists, so it has to be set here
  // rather than inferred from the outcome.
  @HttpCode(HttpStatus.OK)
  @Post()
  async stream(
    @CurrentUser() identity: UserIdentity,
    @Body() body: ChatRequestDto,
    @Res() response: Response,
  ): Promise<void> {
    response.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      // `no-transform` matters as much as `no-cache`: a proxy that helpfully
      // compresses or rewrites the body will buffer it, and a stream that arrives
      // all at once is not a stream.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tells nginx-family proxies not to buffer. Harmless elsewhere.
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();

    // A browser that navigates away leaves the upstream call running and billable,
    // so stop consuming when the client goes.
    let clientGone = false;
    response.on('close', () => {
      clientGone = true;
    });

    try {
      for await (const event of this.provider.chat(identity, {
        message: body.message,
        ...(body.conversationId === undefined
          ? {}
          : { conversationId: body.conversationId }),
        ...(body.sourceIds === undefined ? {} : { sourceIds: body.sourceIds }),
      })) {
        if (clientGone) break;
        writeEvent(response, 'message', event);
      }

      if (!clientGone) {
        // The completion signal. Absent it, a client cannot distinguish a finished
        // answer from a dropped connection.
        writeEvent(response, 'done', {});
      }
    } catch (error) {
      this.logger.error(
        `Chat stream failed for ${identity.toString()}`,
        error instanceof Error ? error.stack : String(error),
      );

      if (!clientGone) {
        // Deliberately opaque, like the rest of this API's error text. The cause is
        // logged server-side; the client learns that the stream failed, not why.
        writeEvent(response, 'error', {
          message: 'The answer could not be completed.',
        });
      }
    } finally {
      response.end();
    }
  }
}

/**
 * Writes one SSE frame.
 *
 * JSON is emitted on a single line, so no `data:` continuation handling is needed. A
 * raw newline inside a `data:` field would terminate the frame early, and
 * `JSON.stringify` escapes newlines — which is the property this relies on, hence the
 * note rather than leaving it to be rediscovered.
 */
function writeEvent(
  response: Response,
  name: 'message' | 'done' | 'error',
  payload: ChatEvent | Record<string, unknown>,
): void {
  response.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}
