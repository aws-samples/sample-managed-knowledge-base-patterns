import { IsString, Length } from 'class-validator';

/**
 * Request body for fetching a document's content.
 *
 * Both fields come from a {@link SearchHit} the caller already received. Naming a
 * resource in the request is normal and safe; what would not be safe is naming the
 * *user*, and there is deliberately no field for that. The global `ValidationPipe`
 * runs with `forbidNonWhitelisted`, so a client that tries to add `userId`, `email`,
 * or `userContext` gets a 400 rather than having it quietly ignored.
 *
 * Passing an identifier the caller was never shown is not a vulnerability here: the
 * document's ACL is evaluated against the verified identity on every request, so
 * guessing an identifier gains nothing. The API answers "not available" identically
 * whether the guess was wrong or merely forbidden.
 */
export class DocumentContentRequestDto {
  /**
   * Document identifier from `SearchHit.id`.
   *
   * For an S3 data source this is the `s3://` form. The `https://` URL in
   * `SearchHit.uri` is a display link, not a document identifier.
   */
  @IsString()
  @Length(1, 2048)
  documentId!: string;

  /** Data source identifier from `SearchHit.dataSourceId`. */
  @IsString()
  @Length(1, 128)
  dataSourceId!: string;
}
