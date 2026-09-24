/**
 * A document's content, addressed by a short-lived URL.
 *
 * A URL rather than bytes, because that is what the underlying operation returns and
 * proxying the bytes through this service would add nothing: the URL is minted only
 * after the user's access has been checked against the document's ACL, and it is
 * fetchable directly from the browser.
 *
 * ## The URL is a bearer capability
 *
 * Anyone holding it can read the document until it expires — it carries its own
 * signature and is not subject to this application's authentication. That is the
 * service's design, and it is why {@link expiresInSeconds} is part of the contract
 * rather than an implementation detail: a caller that persists, logs, or emails this
 * URL is extending document access to whoever reads it, and the type should make that
 * visible at the point of use.
 */
export interface DocumentContent {
  /**
   * MIME type of the content at {@link url}.
   *
   * The source file's own type, so a caller must decide what it can render rather
   * than assuming text.
   */
  readonly mimeType: string;

  /** Short-lived, pre-authorized URL for the content. */
  readonly url: string;

  /** Seconds from issue until {@link url} stops working. */
  readonly expiresInSeconds: number;

  /** Size in bytes, when the provider reports one. */
  readonly sizeBytes?: number;
}
