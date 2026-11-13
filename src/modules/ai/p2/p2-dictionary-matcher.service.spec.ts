import { describe, expect, it } from 'vitest';

import { P2DictionaryMatcherService } from './p2-dictionary-matcher.service.js';
import type {
  P2DictionaryContext,
  P2DictionaryValues,
  P2SourceSegment,
} from './schemas/p2.schema.js';

/**
 * 只测试 Matcher 的候选关联逻辑。
 * 实际 Segment 的授权由上一层 P2EntryGuardService 完成。
 * 此处使用最小测试桩，避免依赖尚未核对的 P1 其他字段。
 */
function segment(
  content: string,
  domain: 'medical_health' | 'non_medical_health' = 'medical_health',
  id = 'seg_1',
): P2SourceSegment {
  return {
    segment_id: id,
    domain,
    content,
  } as unknown as P2SourceSegment;
}

function dictionary(
  values: Partial<P2DictionaryValues> = {},
): P2DictionaryContext {
  return {
    status: 'available',
    values: {
      categories: [],
      efficacies: [],
      symptoms: [],
      ...values,
    },
  };
}

const matcher = new P2DictionaryMatcherService();

describe('P2DictionaryMatcherService', () => {
  it('精确匹配三个字典维度，并返回多个候选而非 Top 1', () => {
    const result = matcher.match(
      [segment('我有发热、头痛，想找退烧药，看看有没有止痛相关记录')],
      dictionary({
        categories: ['退烧药', '肠胃药'],
        efficacies: ['止痛', '抗过敏'],
        symptoms: ['发热', '头痛', '咳嗽'],
      }),
    );

    expect(result).toEqual([
      {
        kind: 'category',
        dictionary_value: '退烧药',
        matched_concept: '退烧药',
        source_text: '退烧药',
        relation: 'exact',
      },
      {
        kind: 'efficacy',
        dictionary_value: '止痛',
        matched_concept: '止痛',
        source_text: '止痛',
        relation: 'exact',
      },
      {
        kind: 'symptom',
        dictionary_value: '发热',
        matched_concept: '发热',
        source_text: '发热',
        relation: 'exact',
      },
      {
        kind: 'symptom',
        dictionary_value: '头痛',
        matched_concept: '头痛',
        source_text: '头痛',
        relation: 'exact',
      },
    ]);
  });

  it.each([
    ['发烧', '发热', 'symptom'],
    ['头疼', '头痛', 'symptom'],
    ['拉肚子', '腹泻', 'symptom'],
    ['鼻子不通气', '鼻塞', 'symptom'],
    ['退烧', '退热', 'efficacy'],
    ['止痛', '镇痛', 'efficacy'],
  ] as const)('支持明确别名 %s → %s（%s）', (word, label, kind) => {
    const values: P2DictionaryValues = {
      categories: [],
      efficacies: kind === 'efficacy' ? [label] : [],
      symptoms: kind === 'symptom' ? [label] : [],
    };

    expect(matcher.match([segment(`我提到${word}`)], dictionary(values))).toEqual([
      {
        kind,
        dictionary_value: label,
        matched_concept: label,
        source_text: word,
        relation: 'alias',
      },
    ]);
  });

  it('优先使用精确匹配：同一标签不再额外生成别名候选', () => {
    const result = matcher.match(
      [segment('发热，也有人说发烧')],
      dictionary({ symptoms: ['发热'] }),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      dictionary_value: '发热',
      relation: 'exact',
      source_text: '发热',
    });
  });

  it('相同标签跨多个医疗 Segment 只返回一个候选', () => {
    const result = matcher.match(
      [segment('发烧', 'medical_health', 'seg_1'), segment('仍然发热', 'medical_health', 'seg_2')],
      dictionary({ symptoms: ['发热'] }),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.relation).toBe('alias');
    expect(result[0]?.source_text).toBe('发烧');
  });

  it('相同文本属于不同字典维度时保留各自候选', () => {
    const result = matcher.match(
      [segment('止痛')],
      dictionary({ categories: ['止痛'], efficacies: ['止痛'] }),
    );

    expect(result.map(({ kind, dictionary_value }) => [kind, dictionary_value])).toEqual([
      ['category', '止痛'],
      ['efficacy', '止痛'],
    ]);
  });

  it('未匹配时返回空数组，不凭症状推断药物分类或功效', () => {
    expect(
      matcher.match(
        [segment('我发烧了')],
        dictionary({ categories: ['退烧药'], efficacies: ['退热'] }),
      ),
    ).toEqual([]);
  });

  it('空字典与不可用字典都返回空候选', () => {
    const input = [segment('发热')];
    expect(matcher.match(input, { status: 'empty', values: {
      categories: [], efficacies: [], symptoms: [],
    } })).toEqual([]);
    expect(matcher.match(input, { status: 'unavailable', reason: 'read_failed' })).toEqual([]);
    expect(matcher.match(input, { status: 'unavailable', reason: 'invalid_shape' })).toEqual([]);
  });

  it('忽略非医疗 Segment，即使其中有精确标签', () => {
    const result = matcher.match(
      [
        segment('发热', 'non_medical_health', 'seg_1'),
        segment('头疼', 'medical_health', 'seg_2'),
      ],
      dictionary({ symptoms: ['发热', '头痛'] }),
    );

    expect(result.map((item) => item.dictionary_value)).toEqual(['头痛']);
  });

  it('只生成当前用户字典确实包含的标签', () => {
    const result = matcher.match(
      [segment('发烧、头疼、拉肚子')],
      dictionary({ symptoms: ['发热'] }),
    );

    expect(result.map((item) => item.dictionary_value)).toEqual(['发热']);
  });

  it('支持 NFKC 规范化后精确匹配并保留字典原始值', () => {
    const result = matcher.match(
      [segment('我想查ＡＢＣ药')],
      dictionary({ categories: ['ABC药'] }),
    );

    expect(result).toEqual([{
      kind: 'category',
      dictionary_value: 'ABC药',
      matched_concept: 'ABC药',
      source_text: 'ABC药',
      relation: 'exact',
    }]);
  });

  it('不会修改输入 Segment 或用户字典', () => {
    const input = [segment('发烧')];
    const context = dictionary({ symptoms: ['发热'] });
    const inputBefore = structuredClone(input);
    const dictionaryBefore = structuredClone(context);

    matcher.match(input, context);

    expect(input).toEqual(inputBefore);
    expect(context).toEqual(dictionaryBefore);
  });

  it('同一个分组标签不因其中包含近似概念而被拆分匹配', () => {
    const result = matcher.match(
      [segment('我发烧了')],
      dictionary({ symptoms: ['发热咳嗽'] }),
    );

    expect(result).toEqual([]);
  });

  it('明确保留 V1 的字面匹配局限：否定表达也可能出现候选', () => {
    const result = matcher.match(
      [segment('我没有发烧')],
      dictionary({ symptoms: ['发热'] }),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      dictionary_value: '发热',
      relation: 'alias',
    });
    // 候选只是文本关联，不代表用户实际存在发热症状。
  });
});
