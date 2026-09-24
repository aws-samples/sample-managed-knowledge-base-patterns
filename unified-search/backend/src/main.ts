import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { type AppConfig, validateConfig } from './config/configuration.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = new Logger('bootstrap');

  app.use(helmet());

  const config = app.get(ConfigService);

  // Refuse to start without the settings needed to verify a token. A service
  // that comes up and then rejects every request is harder to diagnose than one
  // that will not start, and the alternative — starting with authentication
  // effectively disabled — is not acceptable at all.
  validateConfig({
    port: config.getOrThrow<AppConfig['port']>('port'),
    aws: config.getOrThrow<AppConfig['aws']>('aws'),
    corsAllowedOrigins:
      config.getOrThrow<AppConfig['corsAllowedOrigins']>('corsAllowedOrigins'),
    auth: config.getOrThrow<AppConfig['auth']>('auth'),
  });

  const port = config.getOrThrow<AppConfig['port']>('port');
  const allowedOrigins =
    config.getOrThrow<AppConfig['corsAllowedOrigins']>('corsAllowedOrigins');

  if (allowedOrigins.length === 0) {
    // Warn rather than silently falling back to a permissive default. An empty
    // allowlist in a deployed environment is a misconfiguration, and the
    // convenient fallback is exactly the wrong one.
    logger.warn(
      'CORS_ALLOWED_ORIGINS is empty — no browser origin will be permitted. ' +
        'Set it to the exact origin(s) serving the frontend.',
    );
  }

  app.enableCors({
    origin: [...allowedOrigins],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 600,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Reject unknown properties rather than stripping them silently. A
      // request carrying an unexpected field is a client that disagrees with
      // the contract, and it may be a client attempting to supply an identity.
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // The global authentication guard is registered by `AuthModule`, exempting only
  // /health.

  await app.listen(port);
  logger.log(`Listening on port ${port}`);
}

void bootstrap();
