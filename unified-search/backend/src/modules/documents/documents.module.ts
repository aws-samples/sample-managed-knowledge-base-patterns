import { Module } from '@nestjs/common';

import { BedrockModule } from '../../providers/bedrock/bedrock.module.js';
import { DocumentsController } from './documents.controller.js';

@Module({
  imports: [BedrockModule],
  controllers: [DocumentsController],
})
export class DocumentsModule {}
