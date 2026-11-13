import { Module } from '@nestjs/common';

import {
  UserDictionariesModule,
} from '../user-dictionaries/user-dictionaries.module.js';

import {
  LLM_CLIENT,
} from './llm/llm.interface.js';

import {
  OllamaService,
} from './llm/ollama.service.js';

import {
  P1ParserService,
} from './p1/p1-parser.service.js';

import {
  P1ValidatorService,
} from './p1/p1-validator.service.js';

import {
  P1SafetyGuardService,
} from './p1/p1-safety-guard.service.js';

import {
  P1RouterService,
} from './p1/p1-router.service.js';

import {
  P1Service,
} from './p1/p1.service.js';

import {
  P2EntryGuardService,
} from './p2/p2-entry-guard.service.js';

import {
  P2DictionaryContextService,
} from './p2/p2-dictionary-context.service.js';

import {
  P2DictionaryMatcherService,
} from './p2/p2-dictionary-matcher.service.js';

import {
  P2IntentModelClientService,
} from './p2/p2-intent-model-client.service.js';

import {
  P2IntentValidatorService,
} from './p2/p2-intent-validator.service.js';

import {
  P2OrchestratorService,
} from './p2/p2-orchestrator.service.js';

import {
  AiResponseBuilderService,
} from './ai-response-builder.service.js';

import {
  AiController,
} from './ai.controller.js';

/**
 * 千方记 AI Agent Module
 *
 * 当前实现 P1，并注册 P2 内部服务：
 *
 * - 领域识别
 * - 医疗风险初步评估
 * - 安全检查
 * - 统一路由
 * - 模型客户端
 * - HTTP 响应构建
 * - HTTP Controller
 *
 * P2 仅注册依赖，尚未接入 HTTP 调用链。
 * 暂未接入 P3 / P4。
 */
@Module({
  imports: [UserDictionariesModule],

  controllers: [
    // AI HTTP 入口
    AiController,
  ],

  providers: [
    // ========================================================
    // 1. 统一 LLM 客户端
    // ========================================================

    OllamaService,

    {
      provide: LLM_CLIENT,
      useExisting: OllamaService,
    },

    // ========================================================
    // 2. P1 核心处理组件
    // ========================================================

    P1ParserService,

    P1ValidatorService,

    P1SafetyGuardService,

    P1RouterService,

    P1Service,

    // ========================================================
    // 3. P2 核心处理组件（尚未接入 HTTP）
    // ========================================================

    P2EntryGuardService,

    P2DictionaryContextService,

    P2DictionaryMatcherService,

    P2IntentModelClientService,

    P2IntentValidatorService,

    P2OrchestratorService,

    // ========================================================
    // 4. HTTP 响应构建
    // ========================================================

    AiResponseBuilderService,
  ],

  exports: [
    // P1 总处理入口
    P1Service,

    // 统一响应构建器
    AiResponseBuilderService,

    // 供后续 Agent 阶段复用
    LLM_CLIENT,

    // P2 主流程入口
    P2OrchestratorService,
  ],
})
export class AiModule {}
