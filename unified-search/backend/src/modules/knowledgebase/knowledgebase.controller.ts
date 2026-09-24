import { Controller, Get, Inject } from '@nestjs/common';

import type {
  KnowledgeSource,
  RetrievalCapabilities,
  RetrievalProvider,
} from '../../domain/index.js';
import { RETRIEVAL_PROVIDER } from '../../domain/index.js';

export interface SourcesResponse {
  readonly sources: readonly KnowledgeSource[];

  /**
   * True when any source is not confirmed to filter by document ACL.
   *
   * Computed here rather than left to each client, because getting it wrong is a
   * security misstatement rather than a cosmetic bug. `unknown` counts as unfiltered:
   * documents from a non-ACL source go to every user regardless of identity, and a
   * source whose status cannot be read must be treated as though that were the case.
   */
  readonly hasUnfilteredSources: boolean;
}

/**
 * Describes the knowledge base's shape — its data sources and what the provider can do.
 *
 * Authenticated but not identity-filtered, because it returns configuration rather
 * than content. It is still not public: the set of data sources reveals the structure
 * of an organization's corpus.
 */
@Controller('knowledgebase')
export class KnowledgeBaseController {
  constructor(
    @Inject(RETRIEVAL_PROVIDER) private readonly provider: RetrievalProvider,
  ) {}

  @Get('sources')
  async sources(): Promise<SourcesResponse> {
    const sources = await this.provider.listSources();

    return {
      sources,
      hasUnfilteredSources: sources.some((source) => source.aclFiltering !== 'enabled'),
    };
  }

  /**
   * What this deployment can actually do.
   *
   * Exposed so a UI degrades honestly rather than offering a feature that silently
   * does nothing. Without a memory resource, chat is single-turn, and a chat UI should
   * say so instead of appearing to forget.
   */
  @Get('capabilities')
  capabilities(): RetrievalCapabilities {
    return this.provider.capabilities;
  }
}
