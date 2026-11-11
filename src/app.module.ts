
import {
  MiddlewareConsumer,
  Module,
  NestModule,
  ValidationPipe,
} from '@nestjs/common';

import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';

import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter.js';
import { createValidationException } from './common/validation/validation-exception.factory.js';

import { validateEnv } from './config/env.validation.js';

import { PrismaModule } from './database/prisma/prisma.module.js';

import { MedicinesModule } from './modules/medicines/medicines.module.js';
import { VisitsModule } from './modules/visits/visits.module.js';
import { RemindersModule } from './modules/reminders/reminders.module.js';

import { AuthModule } from './modules/auth/auth.module.js';
import { UserContextMiddleware } from './modules/auth/user-context.service.js';

import { SyncModule } from './modules/sync/sync.module.js';
import { UserDictionariesModule } from './modules/user-dictionaries/user-dictionaries.module.js';

import { SmsHookModule } from './modules/sms-hook/sms-hook.module.js';

// P1 AI Agent 模块
import { AiModule } from './modules/ai/ai.module.js';

import { HealthController } from './health.controller.js';

@Module({
  controllers: [
    HealthController,
  ],

  imports: [
    // 全局环境变量配置
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),

    // 数据库
    PrismaModule,

    // 认证与短信
    AuthModule,
    SmsHookModule,

    // 现有业务模块
    MedicinesModule,
    VisitsModule,
    RemindersModule,
    SyncModule,
    UserDictionariesModule,

    // AI Agent：当前实现 P1
    AiModule,
  ],

  providers: [
    // 全局请求参数校验
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: createValidationException,
      }),
    },

    // 全局 HTTP 异常过滤器
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },

    // 全局 Prisma 异常过滤器
    {
      provide: APP_FILTER,
      useClass: PrismaExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(UserContextMiddleware)
      .forRoutes('*');
  }
}
