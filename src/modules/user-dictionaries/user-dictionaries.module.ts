import { Module } from '@nestjs/common';

import { UserDictionariesController } from './user-dictionaries.controller.js';
import { UserDictionariesService } from './user-dictionaries.service.js';

/**
 * 保留既有字典 API 和 Service 注册方式。
 * 导出 Service，供 AiModule 的 P2 字典上下文适配器复用。
 */
@Module({
  controllers: [UserDictionariesController],
  providers: [UserDictionariesService],
  exports: [UserDictionariesService],
})
export class UserDictionariesModule {}
