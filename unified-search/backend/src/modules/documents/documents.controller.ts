import { Body, Controller, Inject, Post } from '@nestjs/common';

import type {
  DocumentContent,
  RetrievalProvider,
  UserIdentity,
} from '../../domain/index.js';
import { RETRIEVAL_PROVIDER } from '../../domain/index.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { DocumentContentRequestDto } from './documents.dto.js';

/**
 * Serves the full text of a document a search result points at.
 *
 * Search returns a snippet — one chunk of one document — which is enough to decide
 * whether a document is worth reading and not enough to read it. Without this
 * endpoint the only thing a result can link to is the connector's own URL, and for
 * an S3 data source that is a private bucket: the browser gets
 * `AccessDenied` from S3, which looks like a broken app rather than a private bucket
 * working correctly.
 *
 * ## This is the sample's sharpest access-control moment
 *
 * Everywhere else, identity *filters a result set*. Here it *authorizes a named
 * resource*, and the failure modes are not symmetric. A search that omits identity
 * returns an empty page — visibly broken, safe. A document fetch that omits identity
 * returns the document — invisibly broken, unsafe. The provider therefore requires
 * the identity as an argument, and it comes only from {@link CurrentUser}, which
 * reads the verified token.
 *
 * `POST` rather than `GET`, consistently with `/search`: it keeps document
 * identifiers out of URLs and therefore out of access logs, browser history, and
 * referrer headers. Which documents a person opened is as revealing as what they
 * searched for.
 *
 * The response carries a short-lived URL rather than the bytes. Proxying the bytes
 * would add a hop and buy nothing — the URL is issued only after the ACL check
 * succeeds — but it does mean the URL is a bearer capability for its lifetime, which
 * is why {@link DocumentContent} states the expiry as part of the contract.
 */
@Controller('documents')
export class DocumentsController {
  constructor(
    @Inject(RETRIEVAL_PROVIDER) private readonly provider: RetrievalProvider,
  ) {}

  @Post('content')
  content(
    // First parameter, mirroring the port. There is no path from the request body
    // to the identity used for the access decision.
    @CurrentUser() identity: UserIdentity,
    @Body() body: DocumentContentRequestDto,
  ): Promise<DocumentContent> {
    return this.provider.getDocument(identity, body.documentId, body.dataSourceId);
  }
}
