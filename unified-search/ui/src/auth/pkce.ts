/**
 * PKCE code verifier and challenge generation.
 *
 * Authorization Code with PKCE is the flow for a browser app: it is a public client, so
 * it holds no secret, and PKCE is what stops an intercepted authorization code from
 * being redeemed by anyone else. The implicit flow — which returns tokens directly in
 * the URL fragment — is deprecated for exactly the reasons that matter here: tokens
 * land in browser history and referrer headers.
 *
 * Uses `crypto.getRandomValues` and `crypto.subtle`, both standard in every browser this
 * targets. Nothing here is hand-rolled cryptography; it is the RFC 7636 construction of
 * a random string and its SHA-256 hash.
 */

/** RFC 7636 permits 43–128 characters. 64 random bytes yields 86 base64url characters. */
const VERIFIER_BYTES = 64;

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

/**
 * Generates a fresh verifier and its S256 challenge.
 *
 * A new pair per authorization request. Reusing one would let a previously observed
 * challenge be replayed, which is the property PKCE exists to provide.
 */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = base64UrlEncode(
    crypto.getRandomValues(new Uint8Array(VERIFIER_BYTES)),
  );
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

/**
 * Random value for the `state` parameter.
 *
 * Distinct from the verifier and not derived from it. `state` defends against CSRF on
 * the redirect — it proves the callback belongs to an authorization request this tab
 * started — which is a different property from PKCE's proof-of-possession, so reusing
 * one value for both would weaken each.
 */
export function createState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * base64url without padding, per RFC 7636.
 *
 * Standard base64 would be rejected: `+`, `/`, and `=` are not valid in the query
 * parameter, and a server comparing the challenge byte-for-byte fails on the
 * difference rather than reporting anything useful.
 */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
