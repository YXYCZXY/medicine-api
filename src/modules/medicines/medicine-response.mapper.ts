import type { Prisma } from '../../generated/prisma/client.js';

/**
 * 查询药品时需要的字段，只包含会输出给前端的列
 */
export const MEDICINE_SELECT = {
  id: true,
  name: true,
  quantity: true,
  unit: true,
  expiration_date: true,
  efficacy: true,
  dose_per_time: true,
  times_per_day: true,
  medication_timings: true,
  location: true,
  note: true,
  created_at: true,
  updated_at: true,
  medicine_categories: {
    select: {
      id: true,
      name: true,
    },
  },
} as const satisfies Prisma.medicine_itemsSelect;

export const CATEGORY_SELECT = {
  id: true,
  name: true,
  sort_order: true,
} as const satisfies Prisma.medicine_categoriesSelect;

export type MedicineRecord = Prisma.medicine_itemsGetPayload<{
  select: typeof MEDICINE_SELECT;
}>;

export type CategoryRecord = Prisma.medicine_categoriesGetPayload<{
  select: typeof CATEGORY_SELECT;
}>;

export type MedicineResponse = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  expirationDate: string | null;
  efficacyTags: string[];
  dosePerTime: number | null;
  timesPerDay: number | null;
  medicationTimings: string[];
  locationId: string | null;
  note: string | null;
  category: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
};

export type CategoryResponse = {
  id: string;
  name: string;
  sortOrder: number;
};

/**
 * 有效期写入时按 UTC 零点保存，读取同样按 UTC 截取，避免时区偏移一天
 */
function toDateOnly(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

export function toMedicineResponse(item: MedicineRecord): MedicineResponse {
  return {
    id: item.id,
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    expirationDate: toDateOnly(item.expiration_date),
    efficacyTags: item.efficacy,
    dosePerTime: item.dose_per_time ? item.dose_per_time.toNumber() : null,
    timesPerDay: item.times_per_day,
    medicationTimings: item.medication_timings,
    locationId: item.location,
    note: item.note,
    category: item.medicine_categories
      ? {
          id: item.medicine_categories.id,
          name: item.medicine_categories.name,
        }
      : null,
    createdAt: item.created_at.toISOString(),
    updatedAt: item.updated_at.toISOString(),
  };
}

export function toCategoryResponse(item: CategoryRecord): CategoryResponse {
  return {
    id: item.id,
    name: item.name,
    sortOrder: item.sort_order,
  };
}
