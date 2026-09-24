export type { TokenVerifier } from './token-verifier.js';

/**
 * Injection token for the configured {@link TokenVerifier}.
 *
 * Separated from the implementation module so the guard can depend on the
 * interface without importing `jose` transitively.
 */
export const TOKEN_VERIFIER = 'TOKEN_VERIFIER';
