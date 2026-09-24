import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import {
  type AuthConfig,
  cognitoIssuer,
  cognitoJwksUri,
} from '../../config/configuration.js';
import { AuthGuard } from './auth.guard.js';
import { CognitoTokenVerifier } from './token-verifier.js';
import { TOKEN_VERIFIER } from './token-verifier.tokens.js';

/**
 * Wires authentication, and registers the guard with `APP_GUARD` so it applies to
 * every route in the application.
 *
 * Global-by-default is the important part. A guard opted into per controller
 * protects only the controllers someone remembered to annotate, so an endpoint
 * added later would ship open. Here the default is closed and opening
 * a route requires an explicit, greppable `@Public()`.
 *
 * There is no session store and no credential vending. The client presents its
 * Cognito ID token on each request and the token is verified each time. Bedrock
 * Managed Knowledge Base takes a verified identity as a request field, so there
 * is no credential exchange to perform and nothing worth persisting.
 */
@Global()
@Module({
  providers: [
    {
      provide: TOKEN_VERIFIER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.getOrThrow<AuthConfig>('auth');
        return new CognitoTokenVerifier({
          issuer: cognitoIssuer(auth),
          audience: auth.clientId,
          jwksUri: cognitoJwksUri(auth),
        });
      },
    },
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  exports: [TOKEN_VERIFIER],
})
export class AuthModule {}
