/** 业务时区：开发期固定为 Asia/Singapore */
export const BUSINESS_TIME_ZONE = 'Asia/Singapore';

/**
 * 将 YYYY-MM-DD 转为 UTC 零点 Date，写入 PostgreSQL DATE
 */
export function toDateOnlyUtc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * 从 Date（DATE 列）读回 YYYY-MM-DD
 */
export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * 业务时区下的「今天」YYYY-MM-DD
 */
export function todayInBusinessTz(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * 就诊日期不得晚于业务时区的今天
 */
export function isVisitDateNotAfterToday(visitDate: string, now?: Date): boolean {
  return visitDate <= todayInBusinessTz(now);
}
