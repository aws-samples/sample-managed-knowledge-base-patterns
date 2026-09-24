import { Module } from '@nestjs/common';

import { BedrockModule } from '../../providers/bedrock/bedrock.module.js';
import { SearchController } from './search.controller.js';

@Module({
  imports: [BedrockModule],
  controllers: [SearchController],
})
export class SearchModule {}
