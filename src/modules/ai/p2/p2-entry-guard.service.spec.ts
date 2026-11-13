import { describe, expect, it } from 'vitest';

import { P2EntryGuardService } from './p2-entry-guard.service.js';

/**
 * 只测试 P2 Entry Guard 的入口契约，不模拟 P1 的领域识别或风险判断。
 * 以 unknown 输入覆盖运行时防御性分支，避免依赖 P1Result 的未确认字段。
 */
const medicalSegment = (id: string, content = '查看药箱') => ({
  segment_id: id,
  content,
  domain: 'medical_health',
});

const nonMedicalSegment = (id: string, content = '讲个笑话') => ({
  segment_id: id,
  content,
  domain: 'non_medical_health',
});

const allowedRoute = (
  segments: unknown[] = [medicalSegment('seg_1')],
  allowedSegmentIds: unknown = ['seg_1'],
  safetyNoticeRequired: unknown = false,
) => ({
  action: 'CONTINUE_TO_P2',
  result: { segments },
  allowedSegmentIds,
  safetyNoticeRequired,
});

const fallback = {
  action: 'SAFE_FALLBACK',
  reason: 'INVALID_P1_SOURCE',
} as const;

describe('P2EntryGuardService', () => {
  const guard = new P2EntryGuardService();

  describe('合法入口', () => {
    it('放行合法的单个医疗 Segment，并保留上游 route 引用', () => {
      const route = allowedRoute();
      const result = guard.check(route);

      expect(result.action).toBe('CONTINUE_TO_P2');
      if (result.action !== 'CONTINUE_TO_P2') {
        throw new Error('合法路由不应被拒绝');
      }

      expect(result.allowedSegments).toEqual([medicalSegment('seg_1')]);
      expect(result.safetyNoticeRequired).toBe(false);
      expect(result.p1Route).toBe(route);
    });

    it('混合领域只返回医疗 Segment，不向 P2 泄露非医疗内容', () => {
      const route = allowedRoute(
        [
          nonMedicalSegment('seg_0'),
          medicalSegment('seg_1', '我发烧了'),
          nonMedicalSegment('seg_3'),
          medicalSegment('seg_2', '看看药箱'),
        ],
        ['seg_2', 'seg_1'],
      );

      const result = guard.check(route);
      expect(result.action).toBe('CONTINUE_TO_P2');
      if (result.action !== 'CONTINUE_TO_P2') {
        throw new Error('合法混合领域路由不应被拒绝');
      }

      expect(result.allowedSegments.map((s) => s.segment_id)).toEqual([
        'seg_1',
        'seg_2',
      ]);
      expect(result.allowedSegments.map((s) => s.content)).toEqual([
        '我发烧了',
        '看看药箱',
      ]);
    });

    it('原样传递 P1 要求的安全提示标志', () => {
      const result = guard.check(
        allowedRoute([medicalSegment('seg_1')], ['seg_1'], true),
      );

      expect(result.action).toBe('CONTINUE_TO_P2');
      if (result.action === 'CONTINUE_TO_P2') {
        expect(result.safetyNoticeRequired).toBe(true);
      }
    });
  });

  describe('阻止不允许进入 P2 的路由', () => {
    it.each(['REFUSE', 'URGENT_RESPONSE', 'SAFE_FALLBACK'])(
      '拒绝 action=%s',
      (action) => {
        expect(guard.check({ action, result: { segments: [] } })).toEqual(
          fallback,
        );
      },
    );

    it.each([null, undefined, 0, 'CONTINUE_TO_P2', [], {}])(
      '拒绝非合法 Router 对象：%s',
      (input) => {
        expect(guard.check(input)).toEqual(fallback);
      },
    );
  });

  describe('白名单和 Segment 一致性检查', () => {
    it('拒绝空白名单', () => {
      expect(guard.check(allowedRoute(undefined, []))).toEqual(fallback);
    });

    it('拒绝重复的白名单 ID', () => {
      expect(guard.check(allowedRoute(undefined, ['seg_1', 'seg_1']))).toEqual(
        fallback,
      );
    });

    it.each([[''], ['   '], [123], [null], 'seg_1', null])(
      '拒绝格式错误的白名单：%s',
      (ids) => {
        expect(guard.check(allowedRoute(undefined, ids))).toEqual(fallback);
      },
    );

    it('拒绝白名单包含非医疗 Segment ID', () => {
      const route = allowedRoute(
        [medicalSegment('seg_1'), nonMedicalSegment('seg_2')],
        ['seg_1', 'seg_2'],
      );
      expect(guard.check(route)).toEqual(fallback);
    });

    it('拒绝医疗 Segment 没有全部出现在白名单', () => {
      const route = allowedRoute(
        [medicalSegment('seg_1'), medicalSegment('seg_2')],
        ['seg_1'],
      );
      expect(guard.check(route)).toEqual(fallback);
    });

    it('拒绝白名单引用不存在的 Segment', () => {
      expect(guard.check(allowedRoute(undefined, ['seg_999']))).toEqual(
        fallback,
      );
    });

    it('拒绝重复的 Segment ID（包括不同领域重复）', () => {
      const route = allowedRoute(
        [medicalSegment('seg_1'), nonMedicalSegment('seg_1')],
        ['seg_1'],
      );
      expect(guard.check(route)).toEqual(fallback);
    });

    it('拒绝医疗 Segment 内容为空或只有空白', () => {
      expect(
        guard.check(allowedRoute([medicalSegment('seg_1', '  ')])),
      ).toEqual(fallback);
    });

    it.each([
      null,
      'not-an-object',
      {},
      { segment_id: 'seg_1', content: 123, domain: 'medical_health' },
      { segment_id: '', content: '查看药箱', domain: 'medical_health' },
    ])('拒绝非法 Segment：%s', (segment) => {
      expect(guard.check(allowedRoute([segment]))).toEqual(fallback);
    });
  });

  describe('路由数据完整性', () => {
    it.each([undefined, null, 'invalid', {}, { segments: null }])(
      '拒绝没有有效 segments 数组的 result：%s',
      (result) => {
        expect(
          guard.check({
            ...allowedRoute(),
            result,
          }),
        ).toEqual(fallback);
      },
    );

    it.each([undefined, null, 'false', 0])(
      '拒绝非法 safetyNoticeRequired：%s',
      (value) => {
        expect(
          guard.check({ ...allowedRoute(), safetyNoticeRequired: value }),
        ).toEqual(fallback);
      },
    );
  });
});
