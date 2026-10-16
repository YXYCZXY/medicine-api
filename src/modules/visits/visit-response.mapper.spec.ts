import { Prisma } from '../../generated/prisma/client.js';

import {
  toInitialVisitSummaryResponse,
  toVisitDetailResponse,
  toVisitMedicineResponse,
  toVisitSummaryResponse,
  type InitialVisitSummaryRecord,
  type VisitDetailRecord,
  type VisitMedicineRecord,
} from './visit-response.mapper.js';

const MEDICINE_ID = '44444444-4444-4444-8444-444444444444';
const VISIT_ID = '33333333-3333-4333-8333-333333333333';
const LINE_ID = '66666666-6666-4666-8666-666666666666';

function createMedicineRecord(
  overrides: Partial<VisitMedicineRecord> = {},
): VisitMedicineRecord {
  return {
    id: LINE_ID,
    medicine_id: MEDICINE_ID,
    name: '布洛芬',
    unit: '粒',
    dose_per_time: new Prisma.Decimal('1.50'),
    times_per_day: 2,
    medication_timings: ['after-meal'],
    usage_note: null,
    sort_order: 0,
    medicine_items: {
      id: MEDICINE_ID,
      name: '布洛芬缓释胶囊',
      quantity: 12,
      unit: '粒',
      expiration_date: new Date('2027-08-01T00:00:00.000Z'),
    },
    ...overrides,
  };
}

function createDetailRecord(
  overrides: Partial<VisitDetailRecord> = {},
): VisitDetailRecord {
  return {
    id: VISIT_ID,
    visit_date: new Date('2026-10-15T00:00:00.000Z'),
    initial_visit_id: null,
    hospital_name: '市第一人民医院',
    department: '呼吸内科',
    doctor_name: '刘主任',
    symptom_tags: ['咳嗽'],
    symptom_note: '干咳两天',
    diagnosis: '上呼吸道感染',
    prescription: '以原处方单为准',
    advice: '按医生要求复查',
    photo_keys: [],
    version: 1,
    created_at: new Date('2026-10-15T01:00:00.000Z'),
    updated_at: new Date('2026-10-15T02:00:00.000Z'),
    visit_medicines: [createMedicineRecord()],
    ...overrides,
  };
}

describe('visit-response.mapper', () => {
  it('用药明细：Decimal 转 number，日期转 YYYY-MM-DD', () => {
    const result = toVisitMedicineResponse(createMedicineRecord());

    expect(result).toEqual({
      id: LINE_ID,
      medicineId: MEDICINE_ID,
      name: '布洛芬',
      unit: '粒',
      dosePerTime: 1.5,
      timesPerDay: 2,
      medicationTimings: ['after-meal'],
      usageNote: null,
      cabinetMedicine: {
        id: MEDICINE_ID,
        name: '布洛芬缓释胶囊',
        quantity: 12,
        unit: '粒',
        expirationDate: '2027-08-01',
      },
    });
  });

  it('药箱已删时 cabinetMedicine 为 null，medicineId 仍可保留', () => {
    const result = toVisitMedicineResponse(
      createMedicineRecord({
        medicine_id: null,
        medicine_items: null,
        dose_per_time: null,
      }),
    );

    expect(result.medicineId).toBeNull();
    expect(result.cabinetMedicine).toBeNull();
    expect(result.dosePerTime).toBeNull();
  });

  it('列表摘要：photoCount 按 photo_keys 长度，不含 prescription', () => {
    const result = toVisitSummaryResponse(
      createDetailRecord({ photo_keys: ['a', 'b'] }),
    );

    expect(result.photoCount).toBe(2);
    expect(result.visitDate).toBe('2026-10-15');
    expect(result).not.toHaveProperty('prescription');
    expect(result).not.toHaveProperty('photos');
  });

  it('详情：photos 固定空数组，初诊 initialVisit 为 null', () => {
    const result = toVisitDetailResponse(createDetailRecord(), null);

    expect(result.photos).toEqual([]);
    expect(result.initialVisit).toBeNull();
    expect(result.prescription).toBe('以原处方单为准');
  });

  it('详情：映射 initialVisit 根摘要', () => {
    const root: InitialVisitSummaryRecord = {
      id: '11111111-1111-4111-8111-111111111111',
      visit_date: new Date('2026-09-01T00:00:00.000Z'),
      hospital_name: '市医院',
      diagnosis: '感冒',
      visit_medicines: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          name: '感冒灵',
          unit: '袋',
          dose_per_time: new Prisma.Decimal(1),
          times_per_day: 3,
          medication_timings: [],
        },
      ],
    };

    const result = toVisitDetailResponse(
      createDetailRecord({
        initial_visit_id: root.id,
      }),
      root,
    );

    expect(result.initialVisit).toEqual(
      toInitialVisitSummaryResponse(root),
    );
    expect(result.initialVisitId).toBe(root.id);
  });
});
