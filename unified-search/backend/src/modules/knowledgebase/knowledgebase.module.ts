import { Module } from '@nestjs/common';

import { BedrockModule } from '../../providers/bedrock/bedrock.module.js';
import { KnowledgeBaseController } from './knowledgebase.controller.js';

@Module({
  imports: [BedrockModule],
  controllers: [KnowledgeBaseController],
})
export class KnowledgeBaseModule {}
