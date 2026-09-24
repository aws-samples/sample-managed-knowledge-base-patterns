/**
 * Claims that a token verifier has already validated.
 *
 * Producing this type is an assertion that the signature, issuer, audience, and
 * expiry of the bearer token were all checked. The token verifier is the only thing
 * in production that should construct one.
 */
export interface VerifiedClaims {
  /**
   * The user's email address, read from the verified token payload.
   *
   * This is the ACL join key. Bedrock Managed Knowledge Base matches document
   * permissions on the email address the application supplies, and aliases are
   * not resolved across identity providers. The address must therefore match the
   * email the user has in each connected data source; otherwise that source
   * returns no results for them.
   */
  readonly email: string;

  /**
   * Stable identity-provider subject identifier.
   *
   * Held for logging and correlation, never for ACL matching. Email addresses
   * can be reassigned; the subject cannot, which makes it the safer key for
   * audit trails.
   */
  readonly subject: string;
}

/**
 * An authenticated end user.
 *
 * The constructor is private on purpose. Every retrieval call requires one of
 * these, and the only way to obtain one is {@link UserIdentity.fromVerifiedClaims},
 * whose name states its precondition. That makes it impossible to accidentally
 * build an identity out of a request body, a query parameter, or a header.
 *
 * This is where the application holds up its side of a shared responsibility.
 * Bedrock Managed Knowledge Base applies document ACLs for the user identity the
 * calling application supplies. Authenticating that user is the application's
 * responsibility, so everything a user is permitted to see depends on this email
 * coming from a verified token. A caller-supplied identity would let any user
 * read any document. See SECURITY.md.
 */
export class UserIdentity {
  private constructor(
    readonly email: string,
    readonly subject: string,
  ) {}

  /**
   * Builds an identity from claims that have already been cryptographically
   * verified.
   *
   * @throws {Error} if either claim is absent or blank. Failing here is
   * deliberate: a request that reaches retrieval without a usable email would
   * otherwise be sent to Bedrock with no user context. ACL-enabled data sources
   * return no results in that case (the secure default), which is easy to
   * mistake for an empty index.
   */
  static fromVerifiedClaims(claims: VerifiedClaims): UserIdentity {
    const email = claims.email.trim().toLowerCase();
    const subject = claims.subject.trim();

    if (email.length === 0) {
      throw new Error('Verified claims contained no email; cannot build an identity');
    }
    if (subject.length === 0) {
      throw new Error('Verified claims contained no subject; cannot build an identity');
    }

    return new UserIdentity(email, subject);
  }

  /**
   * Redacted form for logs. Retains enough to correlate a session without
   * writing the full address into log storage.
   */
  toString(): string {
    const [local = '', domain = ''] = this.email.split('@');
    const masked = local.length <= 1 ? '*' : `${local[0]}***`;
    return `UserIdentity(${masked}@${domain})`;
  }
}
