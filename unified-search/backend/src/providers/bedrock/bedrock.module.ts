import { BedrockAgentClient } from '@aws-sdk/client-bedrock-agent';
import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RETRIEVAL_PROVIDER } from '../../domain/index.js';
import type { BedrockProviderConfig } from './bedrock-config.js';
import { BEDROCK_PROVIDER_CONFIG, validateBedrockConfig } from './bedrock-config.js';
import { BedrockRetrievalProvider } from './bedrock-retrieval.provider.js';

/**
 * Binds the Bedrock provider to the {@link RETRIEVAL_PROVIDER} port.
 *
 * This module is the only place that knows which implementation satisfies the port.
 * Everything else injects the token, which keeps the Bedrock SDK confined to this
 * directory and the security-relevant call sites in one reviewable place.
 *
 * No AWS credentials are constructed here. The clients use the default credential
 * chain — the task role in a deployment, the developer's profile locally. Bedrock
 * needs a verified identity on the request, not credentials that embody one, so
 * there is no per-user credential mechanism here at all.
 */
@Module({
  providers: [
    {
      provide: BEDROCK_PROVIDER_CONFIG,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): BedrockProviderConfig => {
        const region = configService.get<string>('aws.region') ?? '';
        const memoryId = (process.env.MEMORY_ID ?? '').trim();
        const longTermNamespace = (process.env.MEMORY_LONG_TERM_NAMESPACE ?? '').trim();

        const config: BedrockProviderConfig = {
          region,
          knowledgeBaseId: (process.env.KNOWLEDGE_BASE_ID ?? '').trim(),
          defaultMaxResults: Number.parseInt(
            process.env.SEARCH_DEFAULT_MAX_RESULTS ?? '10',
            10,
          ),
          reranking: process.env.SEARCH_RERANKING === 'NONE' ? 'NONE' : 'MANAGED',
          ...(memoryId === ''
            ? {}
            : {
                memory: {
                  memoryId,
                  ...(longTermNamespace === '' ? {} : { longTermNamespace }),
                },
              }),
        };

        // Throws rather than starting half-configured, matching the rule the
        // authentication settings follow.
        validateBedrockConfig(config);

        const logger = new Logger('BedrockModule');
        if (config.memory === undefined) {
          logger.log(
            'MEMORY_ID is not set: chat is single-turn. The provider reports ' +
              'conversationMemory: false so the UI can say so rather than appear to forget.',
          );
        } else {
          logger.log(`Conversation memory enabled (memory ${config.memory.memoryId}).`);
        }

        return config;
      },
    },
    {
      provide: BedrockAgentRuntimeClient,
      inject: [BEDROCK_PROVIDER_CONFIG],
      useFactory: (config: BedrockProviderConfig) =>
        new BedrockAgentRuntimeClient({ region: config.region }),
    },
    {
      provide: BedrockAgentClient,
      inject: [BEDROCK_PROVIDER_CONFIG],
      useFactory: (config: BedrockProviderConfig) =>
        new BedrockAgentClient({ region: config.region }),
    },
    {
      provide: RETRIEVAL_PROVIDER,
      inject: [BEDROCK_PROVIDER_CONFIG, BedrockAgentRuntimeClient, BedrockAgentClient],
      useFactory: (
        config: BedrockProviderConfig,
        runtime: BedrockAgentRuntimeClient,
        control: BedrockAgentClient,
      ) => new BedrockRetrievalProvider(config, runtime, control),
    },
  ],
  exports: [RETRIEVAL_PROVIDER],
})
export class BedrockModule {}
