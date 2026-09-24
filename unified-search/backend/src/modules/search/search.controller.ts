import { Body, Controller, Inject, Post } from '@nestjs/common';

import type {
  RetrievalProvider,
  SearchPage,
  UserIdentity,
} from '../../domain/index.js';
import { RETRIEVAL_PROVIDER } from '../../domain/index.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SearchRequestDto } from './search.dto.js';

/**
 * Enterprise search over the knowledge base.
 *
 * Returns domain DTOs, never a provider response. Returning the raw SDK payload
 * would make SDK response shapes part of the public contract and of the
 * frontend types.
 *
 * `POST` rather than `GET` with a query string. The query text is user content of
 * arbitrary length, and putting it in a URL puts it in access logs, browser history,
 * and referrer headers — search queries against a permissioned corpus are themselves
 * sensitive, since they reveal what someone was looking for even when the results were
 * denied.
 */
@Controller('search')
export class SearchController {
  constructor(
    @Inject(RETRIEVAL_PROVIDER) private readonly provider: RetrievalProvider,
  ) {}

  @Post()
  search(
    // First parameter, mirroring the port. The identity comes from the verified
    // token; there is no path from the request body to it.
    @CurrentUser() identity: UserIdentity,
    @Body() body: SearchRequestDto,
  ): Promise<SearchPage> {
    return this.provider.search(identity, {
      text: body.text,
      ...(body.maxResults === undefined ? {} : { maxResults: body.maxResults }),
      ...(body.nextToken === undefined ? {} : { nextToken: body.nextToken }),
      ...(body.sourceIds === undefined ? {} : { sourceIds: body.sourceIds }),
    });
  }
}
