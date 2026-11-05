import { Prisma } from '../../generated/prisma/client.js';

import {
  toMedicineResponse,
  type MedicineRecord,
} from './medicine-response.mapper.js';

function createRecord(overrides: Partial<MedicineRecord> = {}): MedicineRecord {
  return {
    version: 1,
    id: '11111111-1111-4111-8111-111111111111',
    name: '布洛芬缓释胶囊',
    quantity: new Prisma.Decimal(12),
    unit: '粒',
    expiration_date: new Date('2027-03-01T00:00:00.000Z'),
    efficacy: ['退烧', '止痛'],
    dose_per_time: new Prisma.Decimal('1.5'),
    times_per_day: 4,
    medication_timings: ['after-meal', 'bedtime'],
    location: 'living',
    note: '饭后服用',
    created_at: new Date('2026-10-01T08:30:00.000Z'),
    updated_at: new Date('2026-10-02T09:45:00.000Z'),
    category: '止痛',
    ...overrides,
  };
}

describe('toMedicineResponse', () => {
  it('输出 camelCase 字段，Decimal 转 number，日期截取为 YYYY-MM-DD', () => {
    expect(toMedicineResponse(createRecord())).toEqual({
      version: 1,
      id: '11111111-1111-4111-8111-111111111111',
      name: '布洛芬缓释胶囊',
      quantity: 12,
      unit: '粒',
      expirationDate: '2027-03-01',
      efficacyTags: ['退烧', '止痛'],
      dosePerTime: 1.5,
      timesPerDay: 4,
      medicationTimings: ['after-meal', 'bedtime'],
      locationId: 'living',
      note: '饭后服用',
      category: '止痛',
      createdAt: '2026-10-01T08:30:00.000Z',
      updatedAt: '2026-10-02T09:45:00.000Z',
    });
  });

  it('可空字段保持 null', () => {
    const response = toMedicineResponse(
      createRecord({
        expiration_date: null,
        dose_per_time: null,
        times_per_day: null,
        location: null,
        note: null,
      }),
    );

    expect(response.expirationDate).toBeNull();
    expect(response.dosePerTime).toBeNull();
    expect(response.timesPerDay).toBeNull();
    expect(response.locationId).toBeNull();
    expect(response.note).toBeNull();
  });

  it('不泄露数据库内部字段', () => {
    const record = {
      ...createRecord(),
      user_id: '33333333-3333-4333-8333-333333333333',
      specification: '0.3g × 24粒',
    };

    const response = toMedicineResponse(record);

    expect(response).not.toHaveProperty('user_id');
    expect(response).not.toHaveProperty('userId');
    expect(response).not.toHaveProperty('specification');
  });
});

