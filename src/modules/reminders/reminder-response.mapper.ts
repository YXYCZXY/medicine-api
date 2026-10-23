import type { Prisma } from '../../generated/prisma/client.js';
import { formatDateOnly, toDateOnlyUtc } from '../visits/visit-date.js';

export type ReminderRecord = Prisma.health_remindersGetPayload<{
  include: { medicine: true };
}>;
export type CheckinRecord = Prisma.health_reminder_checkinsGetPayload<{
  include: { blood_pressure: true };
}>;
type BloodPressureRecord = Prisma.blood_pressure_recordsGetPayload<{
  include: { checkin: true };
}>;
export type ExpiryRecord = Prisma.medicine_itemsGetPayload<{
  include: { medicine_expiry_states: true };
}>;

/** 血压单位固定为 mmHg 和次/分，不产生医学判断。 */
export function toBloodPressureResponse(row: BloodPressureRecord) {
  return {
    id: row.id,
    reminderId: row.checkin?.reminder_id ?? null,
    checkinId: row.checkin_id,
    systolic: row.systolic,
    diastolic: row.diastolic,
    pulse: row.pulse,
    slot: row.slot,
    measuredAt: row.measured_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** 一次性使用目标日，重复提醒仅计算今天是否执行。 */
export function getOccurrenceDate(
  row: ReminderRecord,
  today: string,
): string | null {
  if (row.frequency === 'once') return formatDateOnly(row.remind_date!);
  if (today < formatDateOnly(row.starts_on)) return null;
  const weekday = toDateOnlyUtc(today).getUTCDay();
  return row.frequency === 'weekdays' && (weekday === 0 || weekday === 6)
    ? null
    : today;
}

/** 根据当次记录推导状态，历史完成不影响下一个执行日。 */
export function toReminderResponse(
  row: ReminderRecord,
  checkin: CheckinRecord | null,
  today: string,
) {
  const occurrenceDate = getOccurrenceDate(row, today);
  const done = checkin?.completed_at != null;
  const status = done
    ? 'completed'
    : occurrenceDate === null
      ? 'not_scheduled'
      : occurrenceDate > today
        ? 'upcoming'
        : occurrenceDate < today
          ? 'overdue'
          : 'pending';
  return {
    id: row.id,
    type: row.type as 'med' | 'daily' | 'visit',
    title: row.title,
    note: row.note,
    frequency: row.frequency as 'daily' | 'weekdays' | 'once',
    date: row.remind_date ? formatDateOnly(row.remind_date) : null,
    time: row.remind_time,
    startsOn: formatDateOnly(row.starts_on),
    recordBloodPressure: row.record_blood_pressure,
    medicine: row.medicine
      ? {
          medicineId: row.medicine.medicine_id,
          name: row.medicine.name,
          unit: row.medicine.unit,
          dosePerTime: row.medicine.dose_per_time?.toNumber() ?? null,
          timesPerDay: row.medicine.times_per_day,
          medicationTimings: row.medicine.medication_timings,
        }
      : null,
    done,
    status,
    occurrenceDate,
    canCheckIn: occurrenceDate !== null && occurrenceDate <= today,
    checkin: {
      id: checkin?.id ?? null,
      version: checkin?.version ?? 0,
      completedAt: checkin?.completed_at?.toISOString() ?? null,
      scheduledTime: checkin?.scheduled_time ?? row.remind_time,
      bloodPressure: checkin?.blood_pressure
        ? toBloodPressureResponse({ ...checkin.blood_pressure, checkin })
        : null,
    },
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** 有效期当日仍有效；15 个有效天数包含今天。 */
export function toExpiryResponse(row: ExpiryRecord, today: string) {
  const expirationDate = formatDateOnly(row.expiration_date!);
  const state = row.medicine_expiry_states.find(
    (item) => formatDateOnly(item.expiration_date) === expirationDate,
  );
  const expired = expirationDate < today;
  return {
    type: 'expiry' as const,
    medicineId: row.id,
    expirationDate,
    title: `${row.name}${expired ? '已过期' : '临期'}`,
    advice: expired
      ? '药品已过有效期，请及时清理'
      : '建议检查药品有效期并及时换新',
    quantity: row.quantity,
    unit: row.unit,
    expired,
    status: state?.dismissed_at
      ? 'dismissed'
      : state?.handled_at
        ? 'handled'
        : 'pending',
    done: state?.handled_at != null,
    version: state?.version ?? 0,
    handledAt: state?.handled_at?.toISOString() ?? null,
    dismissedAt: state?.dismissed_at?.toISOString() ?? null,
  };
}
