import { Module } from '@nestjs/common';

import { BedrockModule } from '../../providers/bedrock/bedrock.module.js';
import { ChatController } from './chat.controller.js';

@Module({
  imports: [BedrockModule],
  controllers: [ChatController],
})
export class ChatModule {}
