import { Module } from '@nestjs/common';

import { UserDictionariesController } from './user-dictionaries.controller.js';
import { UserDictionariesService } from './user-dictionaries.service.js';

@Module({
  controllers: [UserDictionariesController],
  providers: [UserDictionariesService],
})
export class UserDictionariesModule {}
