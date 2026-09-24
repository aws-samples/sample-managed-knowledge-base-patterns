import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

/**
 * Search request body.
 *
 * Every field is declared and validated, which matters more than it looks: the global
 * `ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted`, so **any**
 * property not declared here is rejected with a 400 rather than silently ignored. A
 * client attempting to smuggle `userId`, `email`, or `userContext` into the body
 * therefore gets an error, and the identity used for retrieval comes only from the
 * verified token. A test asserts exactly that.
 *
 * Note what is absent: any notion of who is asking. There is no field for it, by
 * design.
 */
export class SearchRequestDto {
  @IsString()
  @Length(1, 1000)
  text!: string;

  /**
   * Maximum hits to return.
   *
   * Bounded so a caller cannot ask for an unreasonable page. Fewer may come back even
   * when more matches exist, because real-time ACL verification drops candidates
   * without backfilling — a short page is not the end of results.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  maxResults?: number;

  /** Opaque continuation token from a previous page. */
  @IsOptional()
  @IsString()
  @Length(1, 4096)
  nextToken?: string;

  /** Restrict results to these data source IDs. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(25)
  sourceIds?: string[];
}
