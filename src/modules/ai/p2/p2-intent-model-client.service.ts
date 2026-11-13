
import { Inject, Injectable } from '@nestjs/common';

import { LLM_CLIENT } from '../llm/llm.interface.js';
import type {
  LlmClient,
  LlmGenerateRequest,
} from '../llm/llm.interface.js';

import {
  P2_INTENT_PROTOCOL_VERSION,
  P2_INTENT_SYSTEM_INSTRUCTION,
  serializeP2IntentModelRequest,
} from './p2-intent-model.contract.js';
import type {
  P2IntentModelRequest,
} from './p2-intent-model.contract.js';

export type P2IntentModelClientErrorCode =
  | 'INVALID_MODEL_REQUEST'
  | 'EMPTY_MODEL_RESPONSE'
  | 'INVALID_MODEL_JSON'
  | 'INVALID_MODEL_RESULT';

/**
 * 不将用户原文或模型返回文本写入错误消息，避免泄露健康信息。
 * LLM 基础设施错误由统一 LlmClient 抛出，交给后续 P2 流程处理。
 */
export class P2IntentModelClientError extends Error {
  constructor(public readonly code: P2IntentModelClientErrorCode) {
    super(code);
    this.name = 'P2IntentModelClientError';
  }
}

export interface P2IntentModelClientOptions {
  signal?: AbortSignal;
}

/**
 * P2 模型调用层：只负责发送协议输入、解析 JSON，不信任模型输出。
 *
 * 上游必须先通过 P2 Entry Guard，并使用
 * buildP2IntentModelRequest() 构造受限输入。
 * 本服务不执行数据库操作、不做最终 Schema/业务校验。
 */
@Injectable()
export class P2IntentModelClientService {
  constructor(
    @Inject(LLM_CLIENT)
    private readonly llmClient: LlmClient,
  ) {}

  async analyze(
    input: P2IntentModelRequest,
    options: P2IntentModelClientOptions = {},
  ): Promise<unknown> {
    if (!this.isValidRequestEnvelope(input)) {
      throw new P2IntentModelClientError('INVALID_MODEL_REQUEST');
    }

    let serializedInput: string;
    try {
      serializedInput = serializeP2IntentModelRequest(input);
    } catch {
      throw new P2IntentModelClientError('INVALID_MODEL_REQUEST');
    }

    const request: LlmGenerateRequest = {
      messages: [
        {
          role: 'system',
          content: P2_INTENT_SYSTEM_INSTRUCTION,
        },
        {
          role: 'user',
          content: serializedInput,
        },
      ],
      responseFormat: 'json',
      temperature: 0,
      ...(options.signal ? { signal: options.signal } : {}),
    };

    // 统一 LlmClient 负责模型选取、超时、网络异常及取消。
    // 此处不吞掉基础设施错误，交由后续 P2 Orchestrator 安全降级。
    const response = await this.llmClient.generate(request);
    const rawContent = response.content;

    if (
      typeof rawContent !== 'string' ||
      rawContent.trim().length === 0
    ) {
      throw new P2IntentModelClientError('EMPTY_MODEL_RESPONSE');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      throw new P2IntentModelClientError('INVALID_MODEL_JSON');
    }

    if (!this.isRecord(parsed)) {
      throw new P2IntentModelClientError('INVALID_MODEL_RESULT');
    }

    // JSON.parse 成功并不意味着 P2IntentModelResponse 合法。
    // 下一步必须由 P2 Validator 检查所有字段、意图和授权来源。
    return parsed;
  }

  private isValidRequestEnvelope(
    value: unknown,
  ): value is P2IntentModelRequest {
    if (!this.isRecord(value)) return false;

    if (
      value.protocol_version !== P2_INTENT_PROTOCOL_VERSION ||
      !Array.isArray(value.segments) ||
      value.segments.length === 0 ||
      !this.isRecord(value.request_context) ||
      typeof value.request_context.request_time !== 'string' ||
      !Number.isFinite(Date.parse(value.request_context.request_time)) ||
      typeof value.request_context.timezone !== 'string' ||
      value.request_context.timezone.trim().length === 0 ||
      !this.isRecord(value.dictionary) ||
      !Array.isArray(value.dictionary_candidates) ||
      !Array.isArray(value.allowed_intent_types)
    ) {
      return false;
    }

    const seenIds = new Set<string>();

    for (const segment of value.segments) {
      if (
        !this.isRecord(segment) ||
        typeof segment.segment_id !== 'string' ||
        !segment.segment_id.trim() ||
        seenIds.has(segment.segment_id) ||
        typeof segment.content !== 'string' ||
        !segment.content.trim()
      ) {
        return false;
      }

      seenIds.add(segment.segment_id);
    }

    return true;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    );
  }
}
