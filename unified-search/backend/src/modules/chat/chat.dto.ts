import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

/**
 * Chat request body.
 *
 * As with search, every permitted field is declared, and the global `ValidationPipe`
 * runs with `forbidNonWhitelisted`, so anything else is a 400. That is the mechanism
 * stopping a client from supplying `actorId`, `userId`, or an `assistant` turn.
 *
 * Note in particular what is **not** here: message history. The underlying API accepts
 * caller-supplied `assistant` turns, and this deliberately does not expose them.
 * Accepting model-context content from a client is a context-injection vector, and it
 * would round-trip content derived from access-controlled documents through the
 * browser. History comes from AgentCore Memory, keyed on the verified identity.
 */
export class ChatRequestDto {
  @IsString()
  @Length(1, 4000)
  message!: string;

  /**
   * Continues an existing conversation.
   *
   * Scoped *within* a user: the same string from two identities refers to two
   * unrelated conversations, because the provider derives the memory actor from the
   * verified token and not from this. Constrained here anyway — it reaches an AWS API,
   * and an unbounded caller-controlled string does not belong in a request without a
   * length and character check.
   */
  @IsOptional()
  @IsString()
  @Length(1, 128)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'conversationId may contain only letters, digits, and . _ : -',
  })
  conversationId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(25)
  sourceIds?: string[];
}
