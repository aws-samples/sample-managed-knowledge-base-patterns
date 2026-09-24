import type {
  AgenticRetrieveResultItem,
  KnowledgeBaseRetrievalResult,
  RetrievalResultLocation,
} from '@aws-sdk/client-bedrock-agent-runtime';

import type { SearchHit, SourceType } from '../../domain/index.js';

/**
 * Maps Bedrock retrieval results onto {@link SearchHit}.
 *
 * Two mappers rather than one, because the two operations report document identity
 * in different fields:
 *
 * |                        | `Retrieve`            | `AgenticRetrieveStream` |
 * | ---------------------- | --------------------- | ----------------------- |
 * | `documentId`           | present (`s3://…`)    | **absent**              |
 * | `location`             | present (structured)  | **absent**              |
 * | `metadata._document_id`| **absent**            | present (`s3://…`)      |
 * | other `_` metadata     | 9 keys                | the same 9 keys         |
 *
 * The connector-typed `location` union — the structured way to distinguish an S3
 * result from a SharePoint one — is not part of agentic results, so on the chat
 * path source type comes from `_data_source_type` instead.
 */

/**
 * Metadata keys Bedrock attaches to every managed knowledge base result.
 *
 * Underscore-prefixed and service-owned. Named here rather than string-matched at
 * use sites, because matching service-internal attribute names inline in view
 * components is how a provider rename becomes a frontend bug.
 *
 * Nine appear on `Retrieve` results. `_document_id` is a tenth that appears only on
 * agentic results, where it substitutes for the absent top-level `documentId`.
 */
export const METADATA_KEYS = {
  /** Data source that produced the document. Filterable — see {@link buildSourceFilter}. */
  dataSourceId: '_data_source_id',
  /** Connector family, e.g. `S3`. The chat path's only source-type signal. */
  dataSourceType: '_data_source_type',
  /** Document title. For S3 sources, the file name. */
  documentTitle: '_document_title',
  /** HTTPS URL for the document. Matches `location.s3Location.uri` on `Retrieve`. */
  sourceUri: '_source_uri',
  fileType: '_file_type',
  createdAt: '_created_at',
  lastUpdatedAt: '_last_updated_at',
  languageCode: '_language_code',
  chunkId: '_chunk_id',
  /**
   * `s3://`-form document identifier. **Agentic results only.**
   *
   * This is the identifier the ACL operations accept; the HTTPS `_source_uri` is a
   * display link, not a document identifier.
   */
  documentId: '_document_id',
} as const;

/** Metadata as returned: values are `unknown` because connectors vary. */
type BedrockMetadata = Record<string, unknown> | undefined;

function metadataString(metadata: BedrockMetadata, key: string): string | undefined {
  const value = metadata?.[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Normalizes connector-supplied metadata to a plain object.
 *
 * Passed through unchanged apart from the type: callers must narrow before use, and
 * the domain's `Record<string, unknown>` is what forces them to.
 */
function toDomainMetadata(
  metadata: BedrockMetadata,
): Readonly<Record<string, unknown>> {
  return metadata === undefined ? {} : { ...metadata };
}

/**
 * Maps a structured `location` union to a domain source type.
 *
 * `unknown` for anything unrecognised rather than throwing. Bedrock can add
 * connectors, and discarding a result the user is entitled to see is a worse
 * outcome than labeling its origin imprecisely.
 */
function sourceTypeFromLocation(
  location: RetrievalResultLocation | undefined,
): SourceType {
  switch (location?.type) {
    case 'S3':
      return 's3';
    case 'SHAREPOINT':
      return 'sharepoint';
    case 'ONEDRIVE':
      return 'onedrive';
    case 'CONFLUENCE':
      return 'confluence';
    case 'GOOGLEDRIVE':
      return 'google-drive';
    case 'WEB':
      return 'web';
    case 'CUSTOM':
      return 'custom';
    default:
      return 'unknown';
  }
}

/**
 * Maps the `_data_source_type` metadata value to a domain source type.
 *
 * The fallback on the chat path, where no structured `location` is returned.
 */
export function sourceTypeFromMetadata(metadata: BedrockMetadata): SourceType {
  const raw = metadataString(metadata, METADATA_KEYS.dataSourceType)?.toUpperCase();
  switch (raw) {
    case 'S3':
      return 's3';
    case 'SHAREPOINT':
      return 'sharepoint';
    case 'ONEDRIVE':
      return 'onedrive';
    case 'CONFLUENCE':
      return 'confluence';
    case 'GOOGLEDRIVE':
    case 'GOOGLE_DRIVE':
      return 'google-drive';
    case 'WEB':
    case 'WEBCRAWLER':
      return 'web';
    case 'CUSTOM':
      return 'custom';
    default:
      return 'unknown';
  }
}

/** Extracts whichever connector-specific URL the location union happens to carry. */
function uriFromLocation(
  location: RetrievalResultLocation | undefined,
): string | undefined {
  if (location === undefined) return undefined;
  return (
    location.s3Location?.uri ??
    location.sharePointLocation?.url ??
    location.oneDriveLocation?.url ??
    location.confluenceLocation?.url ??
    location.googleDriveLocation?.url ??
    location.webLocation?.url ??
    location.customDocumentLocation?.id ??
    undefined
  );
}

/**
 * Maps a `Retrieve` result.
 *
 * `id` prefers `documentId` — the `s3://` form the ACL debugging operations
 * require — and falls back to the chunk id so that a hit is always addressable
 * even from a connector that reports no document identifier.
 */
export function toSearchHit(result: KnowledgeBaseRetrievalResult): SearchHit {
  const metadata = result.metadata;

  return {
    id:
      result.documentId ??
      metadataString(metadata, METADATA_KEYS.documentId) ??
      metadataString(metadata, METADATA_KEYS.chunkId) ??
      '',
    dataSourceId: metadataString(metadata, METADATA_KEYS.dataSourceId),
    title: metadataString(metadata, METADATA_KEYS.documentTitle),
    // `location` first: it is the structured, connector-aware field, and on S3 it
    // agrees with `_source_uri` anyway.
    uri:
      uriFromLocation(result.location) ??
      metadataString(metadata, METADATA_KEYS.sourceUri),
    snippet: result.content?.text ?? '',
    score: result.score,
    sourceType:
      result.location === undefined
        ? sourceTypeFromMetadata(metadata)
        : sourceTypeFromLocation(result.location),
    metadata: toDomainMetadata(metadata),
  };
}

/**
 * Maps an `AgenticRetrieveStream` result item.
 *
 * Everything identifying the document has to come out of metadata here, since the
 * item itself carries only `content`, `metadata`, and `sourceRetriever` — and
 * `sourceRetriever.identifier` is the knowledge base ID, not the document's.
 */
export function agenticResultToSearchHit(item: AgenticRetrieveResultItem): SearchHit {
  const metadata = item.metadata;

  return {
    id:
      metadataString(metadata, METADATA_KEYS.documentId) ??
      metadataString(metadata, METADATA_KEYS.chunkId) ??
      '',
    dataSourceId: metadataString(metadata, METADATA_KEYS.dataSourceId),
    title: metadataString(metadata, METADATA_KEYS.documentTitle),
    uri: metadataString(metadata, METADATA_KEYS.sourceUri),
    snippet: item.content?.text ?? '',
    // Agentic results carry no score. Left absent rather than defaulted to 0, which
    // would sort as "least relevant" instead of "not ranked".
    sourceType: sourceTypeFromMetadata(metadata),
    metadata: toDomainMetadata(metadata),
  };
}
