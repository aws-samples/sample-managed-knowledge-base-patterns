import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { CognitoTokenVerifier, TokenVerificationError } from './token-verifier.js';
import { TEST_AUDIENCE, TEST_ISSUER, TokenFactory } from './testing/token-factory.js';

describe('CognitoTokenVerifier', () => {
  let tokens: TokenFactory;
  let verifier: CognitoTokenVerifier;

  beforeAll(async () => {
    tokens = await TokenFactory.create();
    verifier = new CognitoTokenVerifier({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      jwksUri: 'https://example.invalid/.well-known/jwks.json',
      getKey: tokens.getKey,
    });
  });

  describe('accepts a legitimate ID token', () => {
    it('returns the email and subject', async () => {
      const token = await tokens.sign({
        email: 'alejandro_rosalez@example.com',
        sub: 'subject-123',
      });

      await expect(verifier.verify(token)).resolves.toEqual({
        email: 'alejandro_rosalez@example.com',
        subject: 'subject-123',
      });
    });

    it('accepts a string "true" for email_verified from federated mappings', async () => {
      const token = await tokens.sign({ email_verified: 'true' });

      await expect(verifier.verify(token)).resolves.toMatchObject({
        email: 'alejandro_rosalez@example.com',
      });
    });
  });

  describe('rejects forged signatures', () => {
    it('rejects a token signed by a key that is not published in the JWKS', async () => {
      const token = await tokens.signWithForeignKey();

      await expect(verifier.verify(token)).rejects.toThrow(TokenVerificationError);
    });

    // The bypass that works whenever the verifier trusts the token's own header.
    it('rejects an unsigned token declaring alg: none', async () => {
      const token = tokens.unsignedToken();

      await expect(verifier.verify(token)).rejects.toThrow(TokenVerificationError);
    });

    // The algorithm-confusion attack: HMAC using the public key as the secret.
    it('rejects a token signed with HS256 using the public key as the secret', async () => {
      const token = await tokens.algorithmConfusionToken();

      await expect(verifier.verify(token)).rejects.toThrow(TokenVerificationError);
    });

    it('rejects a token whose payload was tampered with after signing', async () => {
      const token = await tokens.sign({ email: 'alejandro_rosalez@example.com' });
      const [header, payload, signature] = token.split('.');
      const decoded = JSON.parse(
        Buffer.from(payload!, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;

      decoded['email'] = 'ceo@example.com';
      const tampered = `${header}.${Buffer.from(JSON.stringify(decoded)).toString(
        'base64url',
      )}.${signature}`;

      await expect(verifier.verify(tampered)).rejects.toThrow(TokenVerificationError);
    });
  });

  describe('rejects tokens from the wrong source', () => {
    it('rejects a mismatched issuer', async () => {
      const token = await tokens.sign({
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ATTACKER',
      });

      await expect(verifier.verify(token)).rejects.toThrow(TokenVerificationError);
    });

    it('rejects a mismatched audience', async () => {
      const token = await tokens.sign({ aud: 'some-other-app-client' });

      await expect(verifier.verify(token)).rejects.toThrow(TokenVerificationError);
    });
  });

  describe('rejects tokens outside their validity window', () => {
    it('rejects an expired token', async () => {
      const past = Math.floor(Date.now() / 1000) - 7200;
      const token = await tokens.sign({ exp: past });

      await expect(verifier.verify(token)).rejects.toThrow(TokenVerificationError);
    });

    it('rejects a token that is not yet valid', async () => {
      const future = Math.floor(Date.now() / 1000) + 7200;
      const token = await tokens.sign({ nbf: future, exp: future + 3600 });

      await expect(verifier.verify(token)).rejects.toThrow(TokenVerificationError);
    });
  });

  describe('rejects tokens that cannot identify a user', () => {
    // Cognito access tokens carry no email claim and are issued under different
    // consent semantics, so they must not stand in as proof of identity.
    it('rejects an access token', async () => {
      const token = await tokens.sign({ token_use: 'access' });

      await expect(verifier.verify(token)).rejects.toThrow(/not an ID token/);
    });

    it('rejects a token with no token_use claim', async () => {
      const token = await tokens.sign({ token_use: undefined });

      await expect(verifier.verify(token)).rejects.toThrow(/not an ID token/);
    });

    /**
     * The highest-consequence check in this file.
     *
     * Email is the ACL join key. If a pool permits self-service sign-up,
     * accepting an unverified address lets anyone register under a colleague's
     * email and inherit that person's document access — an unverified email is an
     * attacker-controlled string.
     */
    it('rejects an unverified email address', async () => {
      const token = await tokens.sign({ email_verified: false });

      await expect(verifier.verify(token)).rejects.toThrow(/not verified/);
    });

    it('rejects a token with no email_verified claim at all', async () => {
      const token = await tokens.sign({ email_verified: undefined });

      await expect(verifier.verify(token)).rejects.toThrow(/not verified/);
    });

    it('rejects a truthy-but-not-true email_verified value', async () => {
      // Guards against a loosened check like `if (payload.email_verified)`, which
      // would accept the string "false".
      const token = await tokens.sign({ email_verified: 'false' });

      await expect(verifier.verify(token)).rejects.toThrow(/not verified/);
    });

    it('rejects a token with no email claim', async () => {
      const token = await tokens.sign({ email: undefined });

      await expect(verifier.verify(token)).rejects.toThrow(/no email claim/);
    });

    it('rejects a token with a blank email claim', async () => {
      const token = await tokens.sign({ email: '   ' });

      await expect(verifier.verify(token)).rejects.toThrow(/no email claim/);
    });

    it('rejects a token with no subject claim', async () => {
      const token = await tokens.sign({ sub: undefined });

      await expect(verifier.verify(token)).rejects.toThrow(/no subject claim/);
    });
  });

  describe('rejects malformed input', () => {
    it.each([
      ['empty string', ''],
      ['whitespace', '   '],
      ['not a JWT', 'not-a-token'],
      ['two segments only', 'aaa.bbb'],
      ['garbage segments', 'aaa.bbb.ccc'],
    ])('rejects %s', async (_label, value) => {
      await expect(verifier.verify(value)).rejects.toThrow(TokenVerificationError);
    });
  });

  describe('algorithm pinning', () => {
    /**
     * Pins the intent. The pin is defense in depth.
     *
     * `jose` rejects both attacks covered by the behavioral tests above
     * (`alg: none`, algorithm confusion) even without the `algorithms` option,
     * because it does not implement `none` and an HS256 verification against a
     * resolved RSA key fails on a key-type mismatch. Those tests therefore cannot
     * show whether the pin is present.
     *
     * So this reads the source instead. It exists so that removing the pin is a
     * deliberate act, since the pin would matter under a different library or a
     * future default.
     */
    it('declares an explicit algorithm allowlist in the verify options', () => {
      const source = readFileSync(
        new URL('./token-verifier.ts', import.meta.url).pathname,
        'utf8',
      );

      expect(source).toMatch(/PERMITTED_ALGORITHMS = \['RS256'\]/);
      expect(source).toMatch(/algorithms: \[\.\.\.PERMITTED_ALGORITHMS\]/);
    });
  });

  describe('failure disclosure', () => {
    // Distinguishing "bad signature" from "expired" from "wrong audience" in a
    // response tells an attacker which part of a forged token to fix next. The
    // reason belongs in a server log only.
    it('reports cryptographic and temporal failures with one indistinct reason', async () => {
      const expired = await tokens.sign({ exp: Math.floor(Date.now() / 1000) - 7200 });
      const foreign = await tokens.signWithForeignKey();
      const wrongAudience = await tokens.sign({ aud: 'other' });

      const reasons = await Promise.all(
        [expired, foreign, wrongAudience].map(async (token) => {
          try {
            await verifier.verify(token);
            return 'unexpectedly accepted';
          } catch (error) {
            return (error as Error).message;
          }
        }),
      );

      expect(new Set(reasons).size).toBe(1);
      expect(reasons[0]).toBe('token failed verification');
    });

    it('preserves the underlying cause for server-side logging', async () => {
      const token = await tokens.sign({ exp: Math.floor(Date.now() / 1000) - 7200 });

      // The opaque public reason has to be paired with a specific private one,
      // or a genuine misconfiguration becomes undiagnosable.
      const error = await verifier.verify(token).then(
        () => undefined,
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(TokenVerificationError);
      expect((error as TokenVerificationError).cause).toBeDefined();
    });
  });
});
