import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ChatModule } from './modules/chat/chat.module.js';
import { RetrievalExceptionFilter } from './modules/common/retrieval-exception.filter.js';
import { DocumentsModule } from './modules/documents/documents.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { KnowledgeBaseModule } from './modules/knowledgebase/knowledgebase.module.js';
import { SearchModule } from './modules/search/search.module.js';

/**
 * Root module.
 *
 * `AuthModule` registers a global guard, so every route added by any module
 * imported here is authenticated unless it is explicitly marked `@Public()`.
 *
 * Modules registered here: providers, search, chat, documents, knowledge base, health.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      load: [configuration],
      isGlobal: true,
      cache: true,
    }),
    AuthModule,
    HealthModule,
    SearchModule,
    ChatModule,
    KnowledgeBaseModule,
    DocumentsModule,
  ],
  providers: [
    // Registered globally so every route translating domain errors gets the same
    // mapping, rather than each controller inventing its own status codes.
    { provide: APP_FILTER, useClass: RetrievalExceptionFilter },
  ],
})
export class AppModule {}
