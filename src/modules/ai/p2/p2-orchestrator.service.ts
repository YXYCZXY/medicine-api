
import { Injectable } from '@nestjs/common';

import type { P1RouteResult } from '../p1/p1-router.service.js';

import {
  P2EntryGuardService,
} from './p2-entry-guard.service.js';

import {
  P2DictionaryContextService,
} from './p2-dictionary-context.service.js';

import {
  P2DictionaryMatcherService,
} from './p2-dictionary-matcher.service.js';

import {
  buildP2IntentModelRequest,
} from './p2-intent-model.contract.js';

import {
  P2IntentModelClientError,
  P2IntentModelClientService,
} from './p2-intent-model-client.service.js';

import {
  P2IntentValidationError,
  P2IntentValidatorService,
} from './p2-intent-validator.service.js';

import type {
  P2DictionaryContext,
  P2FallbackReason,
  P2Intent,
  P2OverallStatus,
  P2ProcessResult,
  P2Result,
  P2UnresolvedSegment,
  P2ValidationFailureCategory,
} from './schemas/p2.schema.js';

/** 由后端生成，不能接受浏览器提交的任意时间上下文。 */
export interface P2RequestContext {
  request_time: string;
  timezone: string;
}

export interface P2OrchestratorOptions {
  signal?: AbortSignal;
}

/**
 * P2 主流程编排。
 *
 * 必须由已经执行 P1 Safety Guard 与 P1 Router 的后端调用链调用。
 * P2 只接收 Router 的结果，绝不从客户端接收白名单。
 * 不访问 Prisma、不执行业务 CRUD、不触发 P3。
 */
@Injectable()
export class P2OrchestratorService {
  constructor(
    private readonly entryGuard: P2EntryGuardService,
    private readonly dictionaryContext: P2DictionaryContextService,
    private readonly dictionaryMatcher: P2DictionaryMatcherService,
    private readonly intentModelClient: P2IntentModelClientService,
    private readonly intentValidator: P2IntentValidatorService,
  ) {}

  async process(
    p1Route: P1RouteResult,
    requestContext: P2RequestContext,
    options: P2OrchestratorOptions = {},
  ): Promise<P2ProcessResult> {
    // Guard 必须先执行。
    // 禁止在此之前读取字典或调用模型。
    const entry = this.entryGuard.check(p1Route);

    if (entry.action !== 'CONTINUE_TO_P2') {
      return this.fallback('INVALID_P1_SOURCE');
    }

    if (!this.validRequestContext(requestContext)) {
      return this.fallback('INVALID_P1_SOURCE');
    }

    // 通过现有 UserDictionariesService
    // 读取当前登录用户的字典。
    let dictionary: P2DictionaryContext;

    try {
      dictionary = await this.dictionaryContext.load();
    } catch {
      return this.fallback('DICTIONARY_CONTEXT_INVALID');
    }

    if (!this.validDictionaryContext(dictionary)) {
      return this.fallback('DICTIONARY_CONTEXT_INVALID');
    }

    let request: ReturnType<
      typeof buildP2IntentModelRequest
    >;

    try {
      const candidates = this.dictionaryMatcher.match(
        entry.allowedSegments,
        dictionary,
      );

      request = buildP2IntentModelRequest(
        entry,
        dictionary,
        candidates,
        requestContext,
      );
    } catch {
      return this.fallback('DICTIONARY_CONTEXT_INVALID');
    }

    let rawModelOutput: unknown;

    try {
      rawModelOutput = await this.intentModelClient.analyze(
        request,
        options.signal ? { signal: options.signal } : {},
      );
    } catch (error: unknown) {
      if (error instanceof P2IntentModelClientError) {
        return this.fallback(
          error.code === 'INVALID_MODEL_REQUEST'
            ? 'MODEL_FAILED'
            : 'MODEL_OUTPUT_INVALID',
        );
      }

      return this.fallback('MODEL_FAILED');
    }

    let validated: ReturnType<
      P2IntentValidatorService['validate']
    >;

    try {
      validated = this.intentValidator.validate(
        rawModelOutput,
        request,
      );
    } catch (error: unknown) {
      if (error instanceof P2IntentValidationError) {
        return this.fallback(
          'P2_VALIDATION_FAILED',
          error.category,
        );
      }

      // 未知验证异常同样禁止放行。
      // 只暴露固定分类码，不记录异常内容。
      return this.fallback(
        'P2_VALIDATION_FAILED',
        'UNEXPECTED',
      );
    }

    const result: P2Result = {
      stage: 'P2',

      status: this.calculateStatus(
        validated.intents,
        validated.unresolved_segments,
      ),

      // 只继承 P1 Router 的安全提示决定。
      safety_notice_required: entry.safetyNoticeRequired,

      dictionary_status: dictionary.status,

      intents: validated.intents,

      clarifications: validated.intents.flatMap(
        (intent) =>
          intent.missing_fields.map((missing) => ({
            intent_id: intent.intent_id,
            field: missing.field,
            reason: missing.reason,
          })),
      ),

      unresolved_segments: validated.unresolved_segments,
    };

    return {
      action: 'OK',
      result,
    };
  }

  private calculateStatus(
    intents: readonly P2Intent[],
    unresolved: readonly P2UnresolvedSegment[],
  ): P2OverallStatus {
    const hasUnfinished =
      unresolved.length > 0 ||
      intents.some(
        (intent) =>
          intent.state === 'needs_clarification',
      );

    if (!hasUnfinished) {
      return 'ready';
    }

    // 有些意图已准备好，另一些仍待澄清。
    if (
      intents.some((intent) => intent.state === 'ready')
    ) {
      return 'partial';
    }

    // 没有已准备好的意图。
    return 'needs_clarification';
  }

  private validRequestContext(
    value: unknown,
  ): value is P2RequestContext {
    if (!this.isRecord(value)) {
      return false;
    }

    if (
      typeof value.request_time !== 'string' ||
      !Number.isFinite(Date.parse(value.request_time)) ||
      typeof value.timezone !== 'string' ||
      value.timezone.trim().length === 0
    ) {
      return false;
    }

    try {
      new Intl.DateTimeFormat('en-US', {
        timeZone: value.timezone,
      });

      return true;
    } catch {
      return false;
    }
  }

  private validDictionaryContext(
    value: unknown,
  ): value is P2DictionaryContext {
    if (!this.isRecord(value)) {
      return false;
    }

    if (value.status === 'unavailable') {
      return (
        value.reason === 'read_failed' ||
        value.reason === 'invalid_shape'
      );
    }

    if (
      value.status !== 'available' &&
      value.status !== 'empty'
    ) {
      return false;
    }

    if (!this.isRecord(value.values)) {
      return false;
    }

    const dictionaryValues = value.values;

    const fields = [
      'categories',
      'efficacies',
      'symptoms',
    ] as const;

    let count = 0;

    for (const field of fields) {
      const entries = dictionaryValues[field];

      if (
        !Array.isArray(entries) ||
        !entries.every(
          (item) =>
            typeof item === 'string' &&
            item.trim().length > 0,
        )
      ) {
        return false;
      }

      count += entries.length;
    }

    return value.status === 'empty'
      ? count === 0
      : count > 0;
  }

  private fallback(
    reason: P2FallbackReason,
    category?: P2ValidationFailureCategory,
  ): P2ProcessResult {
    return category === undefined
      ? {
          action: 'SAFE_FALLBACK',
          reason,
        }
      : {
          action: 'SAFE_FALLBACK',
          reason,
          category,
        };
  }

  private isRecord(
    value: unknown,
  ): value is Record<string, unknown> {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    );
  }
}
