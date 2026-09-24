import type { Server } from 'node:http';
import { Body, Controller, Get, type INestApplication, Post } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserIdentity } from '../../domain/index.js';
import { AuthGuard } from './auth.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import { Public } from './public.decorator.js';
import { CognitoTokenVerifier } from './token-verifier.js';
import { TOKEN_VERIFIER } from './token-verifier.tokens.js';
import { TEST_AUDIENCE, TEST_ISSUER, TokenFactory } from './testing/token-factory.js';

interface EchoBody {
  readonly email?: string;
  readonly userId?: string;
}

@Controller('probe')
class ProbeController {
  @Get('protected')
  protectedRoute(@CurrentUser() identity: UserIdentity) {
    return { email: identity.email, subject: identity.subject };
  }

  @Public()
  @Get('open')
  openRoute() {
    return { ok: true };
  }

  /**
   * Accepts a body that tries to assert an identity, and returns the identity the
   * guard actually established. Used to prove the body is ignored.
   */
  @Post('echo')
  echo(@CurrentUser() identity: UserIdentity, @Body() _body: EchoBody) {
    return { email: identity.email };
  }
}

describe('AuthGuard (HTTP)', () => {
  // Typed on the server so `getHttpServer()` is not `any`; INestApplication is
  // generic over it and defaults to `any`.
  let app: INestApplication<Server>;
  let tokens: TokenFactory;

  beforeAll(async () => {
    tokens = await TokenFactory.create();

    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        Reflector,
        {
          provide: TOKEN_VERIFIER,
          useValue: new CognitoTokenVerifier({
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
            jwksUri: 'https://example.invalid/.well-known/jwks.json',
            getKey: tokens.getKey,
          }),
        },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication<INestApplication<Server>>();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => request(app.getHttpServer());

  describe('closed by default', () => {
    it('rejects a request with no Authorization header', async () => {
      await server().get('/probe/protected').expect(401);
    });

    it.each([
      ['wrong scheme', 'Basic abc123'],
      ['bare token with no scheme', 'abc123'],
      ['Bearer with no credential', 'Bearer'],
      ['Bearer with blank credential', 'Bearer    '],
      ['three parts', 'Bearer abc extra'],
    ])('rejects %s', async (_label, header) => {
      await server().get('/probe/protected').set('Authorization', header).expect(401);
    });

    it('rejects a forged token', async () => {
      const token = await tokens.signWithForeignKey();

      await server()
        .get('/probe/protected')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('accepts a lowercase bearer scheme, per RFC 7235', async () => {
      const token = await tokens.sign();

      await server()
        .get('/probe/protected')
        .set('Authorization', `bearer ${token}`)
        .expect(200);
    });
  });

  describe('with a valid token', () => {
    it('establishes the identity from the token claims', async () => {
      const token = await tokens.sign({
        email: 'alejandro_rosalez@example.com',
        sub: 'subject-abc',
      });

      const response = await server()
        .get('/probe/protected')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body).toEqual({
        email: 'alejandro_rosalez@example.com',
        subject: 'subject-abc',
      });
    });

    it('normalizes the email case', async () => {
      const token = await tokens.sign({ email: 'Alejandro_Rosalez@Example.COM' });

      const response = await server()
        .get('/probe/protected')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as { email: string }).email).toBe(
        'alejandro_rosalez@example.com',
      );
    });
  });

  /**
   * The core security property of the whole application.
   *
   * Bedrock Managed Knowledge Base applies document ACLs for the user identity the
   * application supplies; authenticating that user is the application's
   * responsibility. If a caller could influence the identity, any user could read
   * any document on every ACL-enabled data source.
   */
  describe('identity cannot be supplied by the caller', () => {
    it('ignores an email in the request body', async () => {
      const token = await tokens.sign({ email: 'alejandro_rosalez@example.com' });

      const response = await server()
        .post('/probe/echo')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: 'ceo@example.com', userId: 'ceo@example.com' })
        .expect(201);

      expect((response.body as { email: string }).email).toBe(
        'alejandro_rosalez@example.com',
      );
    });

    it.each(['x-user-email', 'x-user-id', 'x-forwarded-user', 'x-authenticated-user'])(
      'ignores a %s header',
      async (header) => {
        const token = await tokens.sign({ email: 'alejandro_rosalez@example.com' });

        const response = await server()
          .get('/probe/protected')
          .set('Authorization', `Bearer ${token}`)
          .set(header, 'ceo@example.com')
          .expect(200);

        expect((response.body as { email: string }).email).toBe(
          'alejandro_rosalez@example.com',
        );
      },
    );

    it('ignores an email in the query string', async () => {
      const token = await tokens.sign({ email: 'alejandro_rosalez@example.com' });

      const response = await server()
        .get('/probe/protected?email=ceo@example.com')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as { email: string }).email).toBe(
        'alejandro_rosalez@example.com',
      );
    });
  });

  describe('@Public()', () => {
    it('allows an unauthenticated request', async () => {
      await server().get('/probe/open').expect(200);
    });

    it('does not leak the exemption to sibling routes on the same controller', async () => {
      // Exemption is per-handler. A controller-level leak would silently open
      // every route alongside the one that was meant to be public.
      await server().get('/probe/protected').expect(401);
    });
  });

  describe('failure responses', () => {
    it('does not disclose why a token was rejected', async () => {
      const expired = await tokens.sign({ exp: Math.floor(Date.now() / 1000) - 7200 });
      const foreign = await tokens.signWithForeignKey();

      const bodies = await Promise.all(
        [expired, foreign].map(async (token) => {
          const response = await server()
            .get('/probe/protected')
            .set('Authorization', `Bearer ${token}`)
            .expect(401);
          return JSON.stringify(response.body);
        }),
      );

      expect(new Set(bodies).size).toBe(1);
      for (const body of bodies) {
        expect(body).not.toMatch(/expired|signature|audience|issuer|jwks/i);
      }
    });

    it('does not echo the rejected token back to the caller', async () => {
      const token = await tokens.signWithForeignKey();

      const response = await server()
        .get('/probe/protected')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);

      expect(JSON.stringify(response.body)).not.toContain(token);
    });
  });
});
