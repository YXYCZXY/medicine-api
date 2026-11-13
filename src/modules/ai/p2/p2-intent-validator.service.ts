
import { Injectable } from '@nestjs/common';

import { P2_INTENT_TYPES } from './p2-intent-model.contract.js';
import type {
  P2IntentModelRequest,
  P2IntentModelResponse,
} from './p2-intent-model.contract.js';
import type {
  P2DictionaryCandidate,
  P2IntentType,
  P2ValidationFailureCategory,
} from './schemas/p2.schema.js';

export class P2IntentValidationError extends Error {
  constructor(public readonly category: P2ValidationFailureCategory) {
    super('P2_VALIDATION_FAILED');
    this.name = 'P2IntentValidationError';
  }
}

/**
 * P2 模型输出的运行时校验器。
 *
 * 只接受后端构造的 P2IntentModelRequest 作为授权上下文。
 * 不会修正、补全或执行模型输出；任何协议违例都拒绝。
 */
@Injectable()
export class P2IntentValidatorService {
  validate(
    output: unknown,
    request: P2IntentModelRequest,
  ): P2IntentModelResponse {
    this.assert(
      this.record(output) &&
      this.keys(output, ['intents', 'unresolved_segments']),
      'INVALID_TOP_LEVEL',
    );
    this.assert(
      Array.isArray(output.intents) &&
      Array.isArray(output.unresolved_segments),
      'INVALID_TOP_LEVEL',
    );
    this.assert(
      Array.isArray(request.segments) &&
      request.segments.length > 0,
      'INVALID_REQUEST_CONTEXT',
    );

    const allowedIds = new Set<string>();

    for (const segment of request.segments) {
      this.assert(
        this.record(segment) &&
        this.nonempty(segment.segment_id) &&
        this.nonempty(segment.content) &&
        !allowedIds.has(segment.segment_id),
        'INVALID_REQUEST_CONTEXT',
      );
      allowedIds.add(segment.segment_id);
    }

    const allowedTypes = new Set<string>(P2_INTENT_TYPES);
    const requestTypes = new Set(request.allowed_intent_types);

    this.assert(requestTypes.size === allowedTypes.size, 'INVALID_REQUEST_CONTEXT');

    for (const type of requestTypes) {
      this.assert(allowedTypes.has(type), 'INVALID_REQUEST_CONTEXT');
    }

    this.assert(
      this.record(request.dictionary) &&
      ['available', 'empty', 'unavailable'].includes(
        request.dictionary.status,
      ),
      'INVALID_REQUEST_CONTEXT',
    );

    const dictionaryTags = new Map<string, Set<string>>();

    if (request.dictionary.status !== 'unavailable') {
      for (const [kind, field] of [
        ['category', 'categories'],
        ['efficacy', 'efficacies'],
        ['symptom', 'symptoms'],
      ] as const) {
        const values = request.dictionary.values[field];

        this.assert(this.stringArray(values), 'INVALID_REQUEST_CONTEXT');
        dictionaryTags.set(kind, new Set(values));
      }
    }

    this.assert(Array.isArray(request.dictionary_candidates), 'INVALID_REQUEST_CONTEXT');

    const permittedCandidates = new Set<string>();

    for (const candidate of request.dictionary_candidates) {
      this.assert(
        this.validCandidate(candidate, dictionaryTags),
        'INVALID_REQUEST_CONTEXT',
      );
      permittedCandidates.add(this.candidateKey(candidate));
    }

    const seenIntentIds = new Set<string>();
    const coveredIds = new Set<string>();

    for (const intent of output.intents) {
      this.assert(this.record(intent), 'INVALID_INTENT_SHAPE');

      this.assert(
        this.keys(intent, [
          'intent_id',
          'type',
          'source_segment_ids',
          'state',
          'parameters',
          'dictionary_candidates',
          'missing_fields',
        ]),
        'INVALID_INTENT_SHAPE',
      );

      this.assert(
        this.nonempty(intent.intent_id) &&
        !seenIntentIds.has(intent.intent_id),
        'INVALID_INTENT_SHAPE',
      );

      seenIntentIds.add(intent.intent_id);

      this.assert(
        typeof intent.type === 'string' &&
        allowedTypes.has(intent.type),
        'INVALID_INTENT_TYPE',
      );

      this.assert(
        requestTypes.has(intent.type as P2IntentType),
        'INVALID_INTENT_TYPE',
      );

      this.assert(
        Array.isArray(intent.source_segment_ids) &&
        intent.source_segment_ids.length > 0,
        'INVALID_SEGMENT_REFERENCE',
      );

      const localIds = new Set<string>();

      for (const id of intent.source_segment_ids) {
        this.assert(
          this.nonempty(id) &&
          allowedIds.has(id) &&
          !localIds.has(id),
          'INVALID_SEGMENT_REFERENCE',
        );

        localIds.add(id);
        coveredIds.add(id);
      }

      this.assert(
        intent.state === 'ready' ||
        intent.state === 'needs_clarification',
        'INVALID_STATE',
      );

      this.assert(Array.isArray(intent.missing_fields), 'INVALID_STATE');

      for (const field of intent.missing_fields) {
        this.assert(
          this.record(field) &&
          this.keys(field, ['field', 'reason']),
          'INVALID_STATE',
        );

        this.assert(this.nonempty(field.field), 'INVALID_STATE');

        this.assert(
          [
            'required',
            'ambiguous',
            'unresolved_reference',
            'unresolved_time',
          ].includes(field.reason as string),
          'INVALID_STATE',
        );
      }

      this.assert(
        intent.state === 'ready'
          ? intent.missing_fields.length === 0
          : intent.missing_fields.length > 0,
        'INVALID_STATE',
      );

      this.assert(
        Array.isArray(intent.dictionary_candidates),
        'INVALID_DICTIONARY_CANDIDATE_SHAPE',
      );

      const seenCandidates = new Set<string>();

      for (const candidate of intent.dictionary_candidates) {
        this.assert(
          this.validCandidate(candidate, dictionaryTags),
          'INVALID_DICTIONARY_CANDIDATE_SHAPE',
        );

        const key = this.candidateKey(
          candidate as P2DictionaryCandidate,
        );

        this.assert(
          permittedCandidates.has(key),
          'INVALID_DICTIONARY_CANDIDATE_NOT_PERMITTED',
        );
        this.assert(
          !seenCandidates.has(key),
          'INVALID_DICTIONARY_CANDIDATE_DUPLICATE',
        );

        seenCandidates.add(key);
      }

      this.assert(
        this.validParameters(
          intent.type,
          intent.parameters,
          intent.state,
        ),
        'INVALID_INTENT_PARAMETERS',
      );
    }

    const seenUnresolved = new Set<string>();

    for (const unresolved of output.unresolved_segments) {
      this.assert(
        this.record(unresolved) &&
        this.keys(unresolved, ['segment_id', 'reason']),
        'INVALID_UNRESOLVED_SEGMENT',
      );

      this.assert(
        this.nonempty(unresolved.segment_id) &&
        allowedIds.has(unresolved.segment_id),
        'INVALID_SEGMENT_REFERENCE',
      );

      this.assert(
        !seenUnresolved.has(unresolved.segment_id),
        'INVALID_SEGMENT_COVERAGE',
      );

      seenUnresolved.add(unresolved.segment_id);

      this.assert(
        unresolved.reason === 'unsupported_intent' ||
        unresolved.reason === 'insufficient_information',
        'INVALID_UNRESOLVED_SEGMENT',
      );

      this.assert(
        !coveredIds.has(unresolved.segment_id),
        'INVALID_SEGMENT_COVERAGE',
      );

      coveredIds.add(unresolved.segment_id);
    }

    this.assert(coveredIds.size === allowedIds.size, 'INVALID_SEGMENT_COVERAGE');

    return output as unknown as P2IntentModelResponse;
  }

  private validParameters(
    type: string,
    value: unknown,
    state: unknown,
  ): boolean {
    if (!this.record(value)) return false;

    switch (type) {
      case 'medical.consult':
        return (
          this.keys(value, [
            'symptoms',
            'medicine_names',
            'keywords',
          ]) &&
          this.stringArray(value.symptoms) &&
          this.stringArray(value.medicine_names) &&
          this.stringArray(value.keywords)
        );

      case 'medicine.search':
        return (
          this.keys(value, [
            'medicine_names',
            'query_focus',
            'keywords',
          ]) &&
          this.stringArray(value.medicine_names) &&
          this.stringArray(value.keywords) &&
          [
            'list',
            'inventory_quantity',
            'record_details',
            'related_records',
          ].includes(value.query_focus as string)
        );

      case 'visit.search':
        return (
          this.keys(
            value,
            ['symptom_keywords', 'keywords'],
            ['time_range', 'limit', 'order'],
          ) &&
          this.stringArray(value.symptom_keywords) &&
          this.stringArray(value.keywords) &&
          (
            !('time_range' in value) ||
            this.timeRange(value.time_range)
          ) &&
          (
            !('limit' in value) ||
            (
              typeof value.limit === 'number' &&
              Number.isSafeInteger(value.limit) &&
              value.limit > 0
            )
          ) &&
          (
            !('order' in value) ||
            value.order === 'recent_first' ||
            value.order === 'oldest_first'
          )
        );

      case 'reminder.search':
        return (
          this.keys(
            value,
            ['keywords'],
            ['time_range'],
          ) &&
          this.stringArray(value.keywords) &&
          (
            !('time_range' in value) ||
            this.timeRange(value.time_range)
          )
        );

      case 'medicine.create':
      case 'visit.create':
      case 'reminder.create':
        return (
          this.keys(value, ['fields']) &&
          this.capturedFields(value.fields) &&
          (
            state !== 'ready' ||
            (value.fields as unknown[]).length > 0
          )
        );

      case 'medicine.update':
      case 'visit.update':
      case 'reminder.update':
        return (
          this.keys(value, ['selector', 'fields']) &&
          this.selector(value.selector) &&
          this.capturedFields(value.fields) &&
          (
            state !== 'ready' ||
            (
              this.hasSelector(value.selector) &&
              (value.fields as unknown[]).length > 0
            )
          )
        );

      case 'medicine.delete':
      case 'visit.delete':
      case 'reminder.delete':
        return (
          this.keys(value, ['selector']) &&
          this.selector(value.selector) &&
          (
            state !== 'ready' ||
            this.hasSelector(value.selector)
          )
        );

      default:
        return false;
    }
  }

  private timeRange(value: unknown): boolean {
    if (
      !this.record(value) ||
      !this.keys(
        value,
        ['raw_text'],
        ['start', 'end'],
      ) ||
      !this.nonempty(value.raw_text)
    ) {
      return false;
    }

    for (const field of ['start', 'end'] as const) {
      if (
        field in value &&
        (
          !this.nonempty(value[field]) ||
          !Number.isFinite(
            Date.parse(value[field] as string),
          )
        )
      ) {
        return false;
      }
    }

    return true;
  }

  private selector(value: unknown): boolean {
    return (
      this.record(value) &&
      this.keys(
        value,
        [],
        ['record_id', 'name', 'reference_text'],
      ) &&
      ['record_id', 'name', 'reference_text'].every(
        (field) =>
          !(field in value) ||
          this.nonempty(value[field]),
      )
    );
  }

  private hasSelector(value: unknown): boolean {
    return (
      this.record(value) &&
      ['record_id', 'name', 'reference_text'].some(
        (field) => this.nonempty(value[field]),
      )
    );
  }

  private capturedFields(value: unknown): boolean {
    return (
      Array.isArray(value) &&
      value.every(
        (field) =>
          this.record(field) &&
          this.keys(
            field,
            ['field_name', 'raw_value'],
          ) &&
          this.nonempty(field.field_name) &&
          this.nonempty(field.raw_value),
      )
    );
  }

  private validCandidate(
    value: unknown,
    tags: Map<string, Set<string>>,
  ): boolean {
    return (
      this.record(value) &&
      this.keys(value, [
        'kind',
        'dictionary_value',
        'matched_concept',
        'source_text',
        'relation',
      ]) &&
      typeof value.kind === 'string' &&
      !!tags.get(value.kind)?.has(
        value.dictionary_value as string,
      ) &&
      this.nonempty(value.matched_concept) &&
      this.nonempty(value.source_text) &&
      [
        'exact',
        'alias',
        'group_member',
        'semantic_candidate',
      ].includes(value.relation as string)
    );
  }

  private candidateKey(
    value: P2DictionaryCandidate,
  ): string {
    return JSON.stringify([
      value.kind,
      value.dictionary_value,
      value.matched_concept,
      value.source_text,
      value.relation,
    ]);
  }

  private keys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = [],
  ): boolean {
    return (
      required.every((key) =>
        Object.hasOwn(value, key),
      ) &&
      Object.keys(value).every(
        (key) =>
          required.includes(key) ||
          optional.includes(key),
      )
    );
  }

  private nonempty(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.trim().length > 0
    );
  }

  private stringArray(
    value: unknown,
  ): value is string[] {
    return (
      Array.isArray(value) &&
      value.every(
        (item) => this.nonempty(item),
      )
    );
  }

  private record(
    value: unknown,
  ): value is Record<string, unknown> {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    );
  }

  private assert(
    condition: unknown,
    category: P2ValidationFailureCategory,
  ): asserts condition {
    if (!condition) {
      throw new P2IntentValidationError(category);
    }
  }
}
