/**
 * Local-only demo seed for Docker Postgres.
 * Usage (PowerShell):
 *   $env:DATABASE_URL = (Get-Content .env.database-local.local | Where-Object { $_ -match '^DATABASE_URL=' }) -replace '^DATABASE_URL=',''
 *   node --experimental-strip-types scripts/seed-local-demo.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import pg from 'pg';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PHONE = '+8613800138000';
const NICKNAME = '演示用户';
const RANGE_START = '2026-05-11';
const RANGE_END = '2026-11-11';

const DEFAULT_DICTIONARY = {
  categories: [
    '感冒咳嗽',
    '退烧止痛',
    '肠胃不适',
    '消炎抗感染',
    '抗过敏',
    '皮肤外用',
    '慢性病',
    '保健品',
    '其他药品',
  ],
  efficacies: ['退烧', '止痛', '消炎', '抗感染', '缓解胃痛', '其他'],
  symptoms: ['发热咳嗽', '鼻塞流涕', '头晕头痛', '恶心腹泻', '其他'],
};

function loadLocalDatabaseUrl(): string {
  if (
    process.env.DATABASE_URL?.includes('127.0.0.1') ||
    process.env.DATABASE_URL?.includes('localhost')
  ) {
    return process.env.DATABASE_URL;
  }
  const file = resolve(process.cwd(), '.env.database-local.local');
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL missing in .env.database-local.local');
  return line.slice('DATABASE_URL='.length).trim();
}

function addDays(isoDate: string, days: number): string {
  const value = new Date(`${isoDate}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function eachDate(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    dates.push(cursor);
  }
  return dates;
}

function isWeekday(isoDate: string): boolean {
  const day = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

function shouldComplete(seed: string, isoDate: string): boolean {
  let hash = 0;
  const text = `${seed}:${isoDate}`;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash % 100 < 85;
}

function fixedUuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `22222222-2222-4222-8222-${hex}`;
}

async function main() {
  const connectionString = loadLocalDatabaseUrl();
  const host = new URL(connectionString).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`Refusing non-local DATABASE_URL host: ${host}`);
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  const ids = {
    amlodipine: fixedUuid(1),
    metformin: fixedUuid(2),
    atorvastatin: fixedUuid(3),
    ibuprofen: fixedUuid(4),
    ganmaoling: fixedUuid(5),
    smecta: fixedUuid(6),
    amoxicillin: fixedUuid(7),
    vitaminC: fixedUuid(8),
    expiredBandAid: fixedUuid(9),
    expiringCold: fixedUuid(10),
    visitHypertension: fixedUuid(101),
    visitHypertensionFu1: fixedUuid(102),
    visitHypertensionFu2: fixedUuid(103),
    visitCold: fixedUuid(104),
    visitColdFu: fixedUuid(105),
    visitStomach: fixedUuid(106),
    visitLipid: fixedUuid(107),
    reminderMed: fixedUuid(201),
    reminderBp: fixedUuid(202),
    reminderVitamin: fixedUuid(203),
    reminderVisit1: fixedUuid(204),
    reminderVisit2: fixedUuid(205),
    reminderVisit3: fixedUuid(206),
  };

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO users (id, nickname, phone, phone_verified_at, status, created_at, updated_at, last_login_at)
       VALUES ($1, $2, $3, $4::date, 'active', $4::date, $5::date, $5::date)`,
      [USER_ID, NICKNAME, PHONE, RANGE_START, RANGE_END],
    );

    await client.query(
      `INSERT INTO user_dictionaries (user_id, categories, efficacies, symptoms, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::date, $6::date)`,
      [
        USER_ID,
        DEFAULT_DICTIONARY.categories,
        DEFAULT_DICTIONARY.efficacies,
        DEFAULT_DICTIONARY.symptoms,
        RANGE_START,
        RANGE_END,
      ],
    );

    const medicines = [
      [
        ids.amlodipine,
        '慢性病',
        '苯磺酸氨氯地平片',
        '5mg*28片',
        '片剂',
        42,
        '片',
        '2027-06-30',
        '辉瑞制药',
        ['其他'],
        1,
        1,
        ['morning'],
        '客厅药箱',
        '高血压长期用药',
        '2026-05-11',
      ],
      [
        ids.metformin,
        '慢性病',
        '盐酸二甲双胍片',
        '0.5g*48片',
        '片剂',
        60,
        '片',
        '2027-03-15',
        '中美上海施贵宝',
        ['其他'],
        1,
        2,
        ['after-meal'],
        '客厅药箱',
        '餐后服用',
        '2026-05-11',
      ],
      [
        ids.atorvastatin,
        '慢性病',
        '阿托伐他汀钙片',
        '20mg*7片',
        '片剂',
        21,
        '片',
        '2027-01-20',
        '辉瑞制药',
        ['其他'],
        1,
        1,
        ['bedtime'],
        '客厅药箱',
        null,
        '2026-05-20',
      ],
      [
        ids.ibuprofen,
        '退烧止痛',
        '布洛芬缓释胶囊',
        '0.3g*20粒',
        '胶囊',
        12,
        '粒',
        '2027-08-01',
        '中美天津史克',
        ['退烧', '止痛'],
        1,
        2,
        ['after-meal'],
        '卧室抽屉',
        null,
        '2026-07-01',
      ],
      [
        ids.ganmaoling,
        '感冒咳嗽',
        '复方感冒灵颗粒',
        '14g*10袋',
        '颗粒剂',
        6,
        '袋',
        '2027-04-10',
        '华润三九',
        ['退烧', '其他'],
        1,
        3,
        ['after-meal'],
        '客厅药箱',
        null,
        '2026-09-10',
      ],
      [
        ids.smecta,
        '肠胃不适',
        '蒙脱石散',
        '3g*10袋',
        '散剂',
        8,
        '袋',
        '2027-02-28',
        '博福-益普生',
        ['缓解胃痛'],
        1,
        3,
        ['before-meal'],
        '厨房储物柜',
        null,
        '2026-08-01',
      ],
      [
        ids.amoxicillin,
        '消炎抗感染',
        '阿莫西林胶囊',
        '0.25g*24粒',
        '胶囊',
        16,
        '粒',
        '2027-05-01',
        '联邦制药',
        ['消炎', '抗感染'],
        2,
        3,
        ['after-meal'],
        '客厅药箱',
        '需按疗程吃完',
        '2026-09-12',
      ],
      [
        ids.vitaminC,
        '保健品',
        '维生素C片',
        '100mg*100片',
        '片剂',
        70,
        '片',
        '2027-12-31',
        '养生堂',
        ['其他'],
        1,
        1,
        ['after-meal'],
        '客厅药箱',
        null,
        '2026-05-15',
      ],
      [
        ids.expiredBandAid,
        '其他药品',
        '创可贴',
        '10片装',
        '贴剂',
        0,
        '片',
        '2026-06-30',
        '云南白药',
        ['其他'],
        null,
        null,
        [],
        '卫生间柜',
        '已过期处理',
        '2026-05-11',
      ],
      [
        ids.expiringCold,
        '感冒咳嗽',
        '板蓝根颗粒',
        '10g*20袋',
        '颗粒剂',
        4,
        '袋',
        '2026-11-15',
        '白云山',
        ['其他'],
        1,
        3,
        ['after-meal'],
        '客厅药箱',
        '临期未处理',
        '2026-06-01',
      ],
    ] as const;

    for (const row of medicines) {
      await client.query(
        `INSERT INTO medicine_items (
           id, user_id, category, name, specification, dosage_form, quantity, unit,
           expiration_date, manufacturer, efficacy, dose_per_time, times_per_day,
           medication_timings, location, note, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9::date, $10, $11::text[], $12, $13,
           $14::text[], $15, $16, $17::date, $18::date
         )`,
        [
          row[0],
          USER_ID,
          row[1],
          row[2],
          row[3],
          row[4],
          row[5],
          row[6],
          row[7],
          row[8],
          row[9],
          row[10],
          row[11],
          row[12],
          row[13],
          row[14],
          row[15],
          RANGE_END,
        ],
      );
    }

    await client.query(
      `INSERT INTO medicine_expiry_states (
         medicine_id, expiration_date, handled_at, dismissed_at, version, created_at, updated_at
       ) VALUES
         ($1, '2026-06-30'::date, '2026-07-01T10:00:00Z', NULL, 1, '2026-06-24'::date, '2026-07-01'::date),
         ($2, '2026-11-15'::date, NULL, NULL, 1, '2026-11-09'::date, '2026-11-09'::date)`,
      [ids.expiredBandAid, ids.expiringCold],
    );

    type VisitMedicine = {
      medicine_id: string;
      name: string;
      unit: string;
      dose_per_time: number;
      times_per_day: number;
      medication_timings: string[];
      usage_note: string | null;
      sort_order: number;
    };

    const visits: Array<{
      id: string;
      visit_date: string;
      initial_visit_id: string | null;
      hospital_name: string;
      department: string;
      doctor_name: string;
      symptom_tags: string[];
      symptom_note: string;
      diagnosis: string;
      prescription: string;
      advice: string;
      medicines: VisitMedicine[];
    }> = [
      {
        id: ids.visitHypertension,
        visit_date: '2026-05-11',
        initial_visit_id: null,
        hospital_name: '市第一人民医院',
        department: '心内科',
        doctor_name: '王医生',
        symptom_tags: ['头晕头痛'],
        symptom_note: '晨起头晕一周',
        diagnosis: '原发性高血压',
        prescription: '氨氯地平 5mg qd；二甲双胍 0.5g bid',
        advice: '低盐饮食，每日测血压',
        medicines: [
          {
            medicine_id: ids.amlodipine,
            name: '苯磺酸氨氯地平片',
            unit: '片',
            dose_per_time: 1,
            times_per_day: 1,
            medication_timings: ['morning'],
            usage_note: '每日早晨一片',
            sort_order: 1,
          },
          {
            medicine_id: ids.metformin,
            name: '盐酸二甲双胍片',
            unit: '片',
            dose_per_time: 1,
            times_per_day: 2,
            medication_timings: ['after-meal'],
            usage_note: '早晚餐后',
            sort_order: 2,
          },
        ],
      },
      {
        id: ids.visitHypertensionFu1,
        visit_date: '2026-07-10',
        initial_visit_id: ids.visitHypertension,
        hospital_name: '市第一人民医院',
        department: '心内科',
        doctor_name: '王医生',
        symptom_tags: ['头晕头痛'],
        symptom_note: '血压控制尚可，偶有头晕',
        diagnosis: '高血压随访',
        prescription: '继续原方案，加阿托伐他汀',
        advice: '一个月后再复诊',
        medicines: [
          {
            medicine_id: ids.atorvastatin,
            name: '阿托伐他汀钙片',
            unit: '片',
            dose_per_time: 1,
            times_per_day: 1,
            medication_timings: ['bedtime'],
            usage_note: '每晚一片',
            sort_order: 1,
          },
        ],
      },
      {
        id: ids.visitHypertensionFu2,
        visit_date: '2026-10-15',
        initial_visit_id: ids.visitHypertension,
        hospital_name: '市第一人民医院',
        department: '心内科',
        doctor_name: '王医生',
        symptom_tags: ['其他'],
        symptom_note: '血压平稳',
        diagnosis: '高血压随访',
        prescription: '维持用药',
        advice: '三个月后复查血脂',
        medicines: [
          {
            medicine_id: ids.amlodipine,
            name: '苯磺酸氨氯地平片',
            unit: '片',
            dose_per_time: 1,
            times_per_day: 1,
            medication_timings: ['morning'],
            usage_note: null,
            sort_order: 1,
          },
        ],
      },
      {
        id: ids.visitCold,
        visit_date: '2026-09-12',
        initial_visit_id: null,
        hospital_name: '社区卫生服务中心',
        department: '全科',
        doctor_name: '李医生',
        symptom_tags: ['发热咳嗽', '鼻塞流涕'],
        symptom_note: '发热两天，咽痛咳嗽',
        diagnosis: '上呼吸道感染',
        prescription: '感冒灵、阿莫西林、布洛芬必要时',
        advice: '多喝水，三天后复诊',
        medicines: [
          {
            medicine_id: ids.ganmaoling,
            name: '复方感冒灵颗粒',
            unit: '袋',
            dose_per_time: 1,
            times_per_day: 3,
            medication_timings: ['after-meal'],
            usage_note: null,
            sort_order: 1,
          },
          {
            medicine_id: ids.amoxicillin,
            name: '阿莫西林胶囊',
            unit: '粒',
            dose_per_time: 2,
            times_per_day: 3,
            medication_timings: ['after-meal'],
            usage_note: '连服5天',
            sort_order: 2,
          },
          {
            medicine_id: ids.ibuprofen,
            name: '布洛芬缓释胶囊',
            unit: '粒',
            dose_per_time: 1,
            times_per_day: 2,
            medication_timings: ['after-meal'],
            usage_note: '发热时服用',
            sort_order: 3,
          },
        ],
      },
      {
        id: ids.visitColdFu,
        visit_date: '2026-09-15',
        initial_visit_id: ids.visitCold,
        hospital_name: '社区卫生服务中心',
        department: '全科',
        doctor_name: '李医生',
        symptom_tags: ['发热咳嗽'],
        symptom_note: '体温已退，仍有轻咳',
        diagnosis: '上呼吸道感染复诊',
        prescription: '继续感冒灵两天',
        advice: '注意休息',
        medicines: [
          {
            medicine_id: ids.ganmaoling,
            name: '复方感冒灵颗粒',
            unit: '袋',
            dose_per_time: 1,
            times_per_day: 3,
            medication_timings: ['after-meal'],
            usage_note: null,
            sort_order: 1,
          },
        ],
      },
      {
        id: ids.visitStomach,
        visit_date: '2026-10-03',
        initial_visit_id: null,
        hospital_name: '市中医院',
        department: '消化内科',
        doctor_name: '赵医生',
        symptom_tags: ['恶心腹泻'],
        symptom_note: '腹泻一天，轻度腹痛',
        diagnosis: '急性肠胃炎',
        prescription: '蒙脱石散',
        advice: '清淡饮食，补液',
        medicines: [
          {
            medicine_id: ids.smecta,
            name: '蒙脱石散',
            unit: '袋',
            dose_per_time: 1,
            times_per_day: 3,
            medication_timings: ['before-meal'],
            usage_note: '饭前服用',
            sort_order: 1,
          },
        ],
      },
      {
        id: ids.visitLipid,
        visit_date: '2026-06-05',
        initial_visit_id: null,
        hospital_name: '市第一人民医院',
        department: '体检中心',
        doctor_name: '体检科',
        symptom_tags: ['其他'],
        symptom_note: '年度体检血脂偏高',
        diagnosis: '血脂异常',
        prescription: '生活方式干预，必要时加他汀',
        advice: '控制饮食，加强运动',
        medicines: [],
      },
    ];

    for (const visit of visits) {
      await client.query(
        `INSERT INTO visit_records (
           id, user_id, visit_date, initial_visit_id, hospital_name, department, doctor_name,
           symptom_tags, symptom_note, diagnosis, prescription, advice, photo_keys, created_at, updated_at
         ) VALUES (
           $1, $2, $3::date, $4, $5, $6, $7,
           $8::text[], $9, $10, $11, $12, '{}'::text[], $3::date, $3::date
         )`,
        [
          visit.id,
          USER_ID,
          visit.visit_date,
          visit.initial_visit_id,
          visit.hospital_name,
          visit.department,
          visit.doctor_name,
          visit.symptom_tags,
          visit.symptom_note,
          visit.diagnosis,
          visit.prescription,
          visit.advice,
        ],
      );

      for (const medicine of visit.medicines) {
        await client.query(
          `INSERT INTO visit_medicines (
             id, visit_id, medicine_id, name, unit, dose_per_time, times_per_day,
             medication_timings, usage_note, sort_order, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8::text[], $9, $10, $11::date, $11::date
           )`,
          [
            randomUUID(),
            visit.id,
            medicine.medicine_id,
            medicine.name,
            medicine.unit,
            medicine.dose_per_time,
            medicine.times_per_day,
            medicine.medication_timings,
            medicine.usage_note,
            medicine.sort_order,
            visit.visit_date,
          ],
        );
      }
    }

    await client.query(
      `INSERT INTO health_reminders (
         id, user_id, type, title, note, frequency, remind_date, remind_time,
         starts_on, record_blood_pressure, created_at, updated_at
       ) VALUES
         ($1, $2, 'med', '早上吃氨氯地平', '起床后随水送服', 'daily', NULL, '07:30', '2026-05-12'::date, false, '2026-05-12'::date, $3::date),
         ($4, $2, 'daily', '测量血压', '坐姿静息五分钟后测量', 'daily', NULL, '08:00', '2026-05-12'::date, true, '2026-05-12'::date, $3::date),
         ($5, $2, 'med', '工作日维生素C', '午餐后服用', 'weekdays', NULL, '12:30', '2026-05-15'::date, false, '2026-05-15'::date, $3::date),
         ($6, $2, 'visit', '心内科复诊', '带上近期血压记录', 'once', '2026-07-10'::date, NULL, '2026-06-20'::date, false, '2026-06-20'::date, '2026-07-10'::date),
         ($7, $2, 'visit', '感冒复诊', '社区卫生服务中心', 'once', '2026-09-15'::date, NULL, '2026-09-12'::date, false, '2026-09-12'::date, '2026-09-15'::date),
         ($8, $2, 'visit', '心内科复查血脂', '空腹抽血', 'once', '2026-11-20'::date, NULL, '2026-10-15'::date, false, '2026-10-15'::date, '2026-10-15'::date)`,
      [
        ids.reminderMed,
        USER_ID,
        RANGE_END,
        ids.reminderBp,
        ids.reminderVitamin,
        ids.reminderVisit1,
        ids.reminderVisit2,
        ids.reminderVisit3,
      ],
    );

    await client.query(
      `INSERT INTO health_reminder_medicines (
         reminder_id, medicine_id, name, unit, dose_per_time, times_per_day,
         medication_timings, created_at, updated_at
       ) VALUES
         ($1, $2, '苯磺酸氨氯地平片', '片', 1, 1, ARRAY['morning']::text[], '2026-05-12'::date, $5::date),
         ($3, $4, '维生素C片', '片', 1, 1, ARRAY['after-meal']::text[], '2026-05-15'::date, $5::date)`,
      [
        ids.reminderMed,
        ids.amlodipine,
        ids.reminderVitamin,
        ids.vitaminC,
        RANGE_END,
      ],
    );

    for (const day of eachDate('2026-05-12', RANGE_END)) {
      if (!shouldComplete('med', day)) continue;
      await client.query(
        `INSERT INTO health_reminder_checkins (
           reminder_id, occurrence_date, scheduled_time, completed_at,
           stock_medicine_id, stock_quantity, stock_unit, created_at, updated_at
         ) VALUES ($1, $2::date, '07:30', ($2 || 'T07:35:00Z')::timestamptz, $3, 1, '片', $2::date, $2::date)`,
        [ids.reminderMed, day, ids.amlodipine],
      );
    }

    for (const day of eachDate('2026-05-15', RANGE_END)) {
      if (!isWeekday(day) || !shouldComplete('vitamin', day)) continue;
      await client.query(
        `INSERT INTO health_reminder_checkins (
           reminder_id, occurrence_date, scheduled_time, completed_at,
           stock_medicine_id, stock_quantity, stock_unit, created_at, updated_at
         ) VALUES ($1, $2::date, '12:30', ($2 || 'T12:40:00Z')::timestamptz, $3, 1, '片', $2::date, $2::date)`,
        [ids.reminderVitamin, day, ids.vitaminC],
      );
    }

    for (const day of eachDate('2026-05-12', RANGE_END)) {
      if (!shouldComplete('bp', day)) continue;
      const checkinId = randomUUID();
      const afternoon = day.endsWith('5') || day.endsWith('0');
      const slot = afternoon ? 'afternoon' : 'morning';
      const measuredAt = afternoon
        ? `${day}T15:10:00.000Z`
        : `${day}T08:05:00.000Z`;
      const hash = [...day].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
      await client.query(
        `INSERT INTO health_reminder_checkins (
           id, reminder_id, occurrence_date, scheduled_time, completed_at, created_at, updated_at
         ) VALUES ($1, $2, $3::date, '08:00', $4::timestamptz, $3::date, $3::date)`,
        [checkinId, ids.reminderBp, day, measuredAt],
      );
      await client.query(
        `INSERT INTO blood_pressure_records (
           user_id, checkin_id, systolic, diastolic, pulse, slot, measured_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz, $7::timestamptz)`,
        [
          USER_ID,
          checkinId,
          118 + (hash % 18),
          72 + (hash % 12),
          68 + (hash % 16),
          slot,
          measuredAt,
        ],
      );
    }

    await client.query('COMMIT');

    const counts = await client.query(
      `SELECT
         (SELECT count(*)::int FROM medicine_items WHERE user_id = $1) AS medicines,
         (SELECT count(*)::int FROM visit_records WHERE user_id = $1) AS visits,
         (SELECT count(*)::int FROM health_reminders WHERE user_id = $1) AS reminders,
         (SELECT count(*)::int FROM health_reminder_checkins c
            JOIN health_reminders r ON r.id = c.reminder_id WHERE r.user_id = $1) AS checkins,
         (SELECT count(*)::int FROM blood_pressure_records WHERE user_id = $1) AS blood_pressure`,
      [USER_ID],
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          userId: USER_ID,
          phone: PHONE,
          range: { start: RANGE_START, end: RANGE_END },
          counts: counts.rows[0],
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
