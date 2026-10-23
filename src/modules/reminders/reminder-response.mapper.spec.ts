import { Prisma } from '../../generated/prisma/client.js';
import {
  getOccurrenceDate,
  toExpiryResponse,
  toReminderResponse,
  type CheckinRecord,
  type ExpiryRecord,
  type ReminderRecord,
} from './reminder-response.mapper.js';

const now = new Date('2026-10-23T02:00:00Z');
const reminder: ReminderRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  type: 'daily',
  title: '测量血压',
  note: null,
  frequency: 'daily',
  remind_date: null,
  remind_time: '08:00',
  starts_on: new Date('2026-10-22T00:00:00Z'),
  record_blood_pressure: true,
  version: 1,
  created_at: now,
  updated_at: now,
  medicine: null,
};
const checkin: CheckinRecord = {
  id: '33333333-3333-4333-8333-333333333333',
  reminder_id: reminder.id,
  occurrence_date: new Date('2026-10-23T00:00:00Z'),
  scheduled_time: '08:00',
  completed_at: now,
  version: 1,
  created_at: now,
  updated_at: now,
  blood_pressure: null,
};

describe('提醒状态映射', () => {
  it('重复提醒每天使用独立执行日，不执行创建前的日期', () => {
    expect(getOccurrenceDate(reminder, '2026-10-21')).toBeNull();
    expect(getOccurrenceDate(reminder, '2026-10-23')).toBe('2026-10-23');
    expect(getOccurrenceDate(reminder, '2026-10-24')).toBe('2026-10-24');
    expect(toReminderResponse(reminder, null, '2026-10-24')).toMatchObject({
      done: false,
      status: 'pending',
      checkin: { version: 0 },
    });
  });

  it.each(['2026-10-24', '2026-10-25'])('工作日提醒在 %s 不执行', (today) => {
    expect(
      toReminderResponse({ ...reminder, frequency: 'weekdays' }, null, today),
    ).toMatchObject({ status: 'not_scheduled', canCheckIn: false });
  });

  it('工作日提醒周五执行，提前打卡无需等到计划时刻', () => {
    expect(
      toReminderResponse(
        { ...reminder, frequency: 'weekdays', remind_time: '23:00' },
        null,
        '2026-10-23',
      ),
    ).toMatchObject({ status: 'pending', canCheckIn: true });
  });

  it.each([
    ['2026-10-24', 'upcoming', false],
    ['2026-10-23', 'pending', true],
    ['2026-10-22', 'overdue', true],
  ])('一次性日期 %s 的状态为 %s', (date, status, canCheckIn) => {
    expect(
      toReminderResponse(
        {
          ...reminder,
          frequency: 'once',
          remind_date: new Date(`${date}T00:00:00Z`),
        },
        null,
        '2026-10-23',
      ),
    ).toMatchObject({ status, canCheckIn });
  });

  it('已完成状态与取消后的血压回填', () => {
    const bp = {
      id: 'bp',
      user_id: reminder.user_id,
      checkin_id: checkin.id,
      systolic: 122,
      diastolic: 80,
      pulse: 72,
      slot: 'morning',
      measured_at: now,
      created_at: now,
      updated_at: now,
    };
    expect(
      toReminderResponse(
        reminder,
        { ...checkin, blood_pressure: bp },
        '2026-10-23',
      ),
    ).toMatchObject({ status: 'completed', done: true });
    expect(
      toReminderResponse(
        reminder,
        { ...checkin, completed_at: null, blood_pressure: bp },
        '2026-10-23',
      ),
    ).toMatchObject({
      done: false,
      checkin: { bloodPressure: { systolic: 122 } },
    });
  });

  it('药箱关联删除后仍显示剂量快照', () => {
    const row = {
      ...reminder,
      type: 'med',
      record_blood_pressure: false,
      medicine: {
        reminder_id: reminder.id,
        medicine_id: null,
        name: '药品',
        unit: '粒',
        dose_per_time: new Prisma.Decimal('0.5'),
        times_per_day: 2,
        medication_timings: ['after-meal'],
        created_at: now,
        updated_at: now,
      },
    };
    expect(toReminderResponse(row, null, '2026-10-23').medicine).toMatchObject({
      medicineId: null,
      dosePerTime: 0.5,
      timesPerDay: 2,
    });
  });

  it('有效期当天有效，第二天过期；旧有效期状态不影响新有效期', () => {
    const medicine = {
      id: 'medicine',
      name: '药品',
      quantity: 1,
      unit: '粒',
      expiration_date: new Date('2026-10-23T00:00:00Z'),
      medicine_expiry_states: [
        {
          expiration_date: new Date('2026-10-22T00:00:00Z'),
          handled_at: now,
          dismissed_at: null,
          version: 3,
        },
      ],
    } as ExpiryRecord;
    expect(toExpiryResponse(medicine, '2026-10-23')).toMatchObject({
      expired: false,
      done: false,
      version: 0,
    });
    expect(toExpiryResponse(medicine, '2026-10-24')).toMatchObject({
      expired: true,
      status: 'pending',
    });
  });
});
