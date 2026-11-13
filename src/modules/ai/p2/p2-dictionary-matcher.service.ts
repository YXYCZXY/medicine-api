
import { Injectable } from '@nestjs/common';

import type {
  P2DictionaryCandidate,
  P2DictionaryContext,
  P2DictionaryKind,
  P2SourceSegment,
} from './schemas/p2.schema.js';

/**
 * V1 明确允许的同义表达。
 * 只在同一字典维度内匹配。
 * 不建立「症状 → 药品分类/功效」的医疗推断关系。
 */
const ALIASES: Readonly<
  Partial<
    Record<
      P2DictionaryKind,
      Readonly<Record<string, readonly string[]>>
    >
  >
> = {
  symptom: {
    发热: ['发烧'],
    头痛: ['头疼'],
    腹泻: ['拉肚子'],
    鼻塞: ['鼻子不通气'],
  },
  efficacy: {
    退热: ['退烧'],
    镇痛: ['止痛'],
  },
};

const DICTIONARY_FIELDS = [
  ['category', 'categories'],
  ['efficacy', 'efficacies'],
  ['symptom', 'symptoms'],
] as const;

/**
 * P2 字典候选匹配器（V1）。
 *
 * - 输入必须是 P2 Entry Guard 已放行的 Segment。
 * - 只使用当前用户字典中的标签。
 * - 支持零到多个候选。
 * - 首版仅做字面匹配和显式别名匹配。
 * - 不做语义扩展或分组标签拆解。
 * - 候选不等于已确认症状、库存记录或治疗建议。
 */
@Injectable()
export class P2DictionaryMatcherService {
  match(
    segments: readonly P2SourceSegment[],
    dictionary: P2DictionaryContext,
  ): P2DictionaryCandidate[] {
    if (dictionary.status === 'unavailable') {
      return [];
    }

    const candidates: P2DictionaryCandidate[] = [];
    const seen = new Set<string>();

    for (const segment of segments) {
      // 防御性领域检查。
      // 不能替代 Entry Guard 的授权校验。
      if (
        segment.domain !== 'medical_health' ||
        typeof segment.content !== 'string'
      ) {
        continue;
      }

      const content = segment.content.normalize('NFKC');

      for (const [kind, field] of DICTIONARY_FIELDS) {
        for (const dictionaryValue of dictionary.values[field]) {
          const value = dictionaryValue.normalize('NFKC');

          if (!value.trim()) continue;

          // 1. 精确匹配
          const directIndex = content.indexOf(value);

          if (directIndex >= 0) {
            this.appendCandidate(
              candidates,
              seen,
              {
                kind,
                dictionary_value: dictionaryValue,
                matched_concept: dictionaryValue,
                source_text: content.slice(
                  directIndex,
                  directIndex + value.length,
                ),
                relation: 'exact',
              },
            );

            continue;
          }

          // 2. 明确配置的别名匹配
          const aliases = ALIASES[kind]?.[dictionaryValue] ?? [];

          for (const alias of aliases) {
            const aliasIndex = content.indexOf(
              alias.normalize('NFKC'),
            );

            if (aliasIndex < 0) continue;

            this.appendCandidate(
              candidates,
              seen,
              {
                kind,
                dictionary_value: dictionaryValue,
                matched_concept: dictionaryValue,
                source_text: alias,
                relation: 'alias',
              },
            );

            break;
          }
        }
      }
    }

    return candidates;
  }

  private appendCandidate(
    output: P2DictionaryCandidate[],
    seen: Set<string>,
    candidate: P2DictionaryCandidate,
  ): void {
    // 候选协议目前没有 Segment ID。
    // 同一个字典标签只返回一次，避免重复候选。
    const key = JSON.stringify([
      candidate.kind,
      candidate.dictionary_value,
    ]);

    if (seen.has(key)) return;

    seen.add(key);
    output.push(candidate);
  }
}
