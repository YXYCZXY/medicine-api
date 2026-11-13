
import { Injectable } from '@nestjs/common';

import type { P1RouteResult } from '../p1/p1-router.service.js';
import type {
  P2AllowedRoute,
  P2FallbackReason,
  P2SourceSegment,
} from './schemas/p2.schema.js';

/**
 * 经过入口检查的 P2 医疗片段集合。
 * 仅供后端内部使用。
 */
export interface P2EntryAccepted {
  action: 'CONTINUE_TO_P2';
  allowedSegments: P2SourceSegment[];
  safetyNoticeRequired: boolean;
  p1Route: P2AllowedRoute;
}

export interface P2EntryRejected {
  action: 'SAFE_FALLBACK';
  reason: Extract<
    P2FallbackReason,
    'INVALID_P1_SOURCE'
  >;
}

export type P2EntryResult =
  | P2EntryAccepted
  | P2EntryRejected;

/**
 * P2 入口守卫。
 *
 * 上游必须已执行 P1 Safety Guard 和 P1 Router。
 * 不重新判断医疗风险，不读取字典，不执行 CRUD。
 */
@Injectable()
export class P2EntryGuardService {
  check(route: P1RouteResult | unknown): P2EntryResult {
    if (
      !this.isRecord(route) ||
      route.action !== 'CONTINUE_TO_P2'
    ) {
      return this.reject();
    }

    const allowedIds = route.allowedSegmentIds;
    const safetyNoticeRequired = route.safetyNoticeRequired;
    const result = route.result;

    if (
      !Array.isArray(allowedIds) ||
      allowedIds.length === 0 ||
      typeof safetyNoticeRequired !== 'boolean' ||
      !this.isRecord(result) ||
      !Array.isArray(result.segments)
    ) {
      return this.reject();
    }

    const allowedIdSet = new Set<string>();

    for (const id of allowedIds) {
      if (
        typeof id !== 'string' ||
        id.trim().length === 0 ||
        allowedIdSet.has(id)
      ) {
        return this.reject();
      }

      allowedIdSet.add(id);
    }

    const medicalIds = new Set<string>();
    const allowedSegments: P2SourceSegment[] = [];
    const seenSegmentIds = new Set<string>();

    for (const segment of result.segments) {
      if (
        !this.isRecord(segment) ||
        typeof segment.segment_id !== 'string' ||
        segment.segment_id.trim().length === 0 ||
        seenSegmentIds.has(segment.segment_id) ||
        typeof segment.content !== 'string'
      ) {
        return this.reject();
      }

      seenSegmentIds.add(segment.segment_id);

      if (segment.domain === 'medical_health') {
        medicalIds.add(segment.segment_id);

        if (
          segment.content.trim().length === 0 ||
          !allowedIdSet.has(segment.segment_id)
        ) {
          return this.reject();
        }

        allowedSegments.push(
          segment as unknown as P2SourceSegment,
        );
      } else if (allowedIdSet.has(segment.segment_id)) {
        // 非医疗片段不能出现在授权白名单中。
        return this.reject();
      }
    }

    // 白名单必须与全部医疗 Segment ID 完全一致。
    if (
      medicalIds.size !== allowedIdSet.size ||
      allowedSegments.length !== allowedIdSet.size
    ) {
      return this.reject();
    }

    return {
      action: 'CONTINUE_TO_P2',
      allowedSegments,
      safetyNoticeRequired,
      p1Route: route as P2AllowedRoute,
    };
  }

  private reject(): P2EntryRejected {
    return {
      action: 'SAFE_FALLBACK',
      reason: 'INVALID_P1_SOURCE',
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
