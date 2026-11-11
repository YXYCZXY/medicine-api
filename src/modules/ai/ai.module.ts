
import { Module } from '@nestjs/common';

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
  AiResponseBuilderService,
} from './ai-response-builder.service.js';

import {
  AiController,
} from './ai.controller.js';

/**
 * 千方记 AI Agent Module
 *
 * 当前实现 P1：
 *
 * - 领域识别
 * - 医疗风险初步评估
 * - 安全检查
 * - 统一路由
 * - 模型客户端
 * - HTTP 响应构建
 * - HTTP Controller
 *
 * 暂未实现 P2 / P3 / P4。
 */
@Module({
  imports: [],

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
    // 3. HTTP 响应构建
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
  ],
})
export class AiModule {}
