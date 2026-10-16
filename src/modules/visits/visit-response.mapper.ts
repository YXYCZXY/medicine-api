import type { Prisma } from '../../generated/prisma/client.js';

import { formatDateOnly } from './visit-date.js';

const CABINET_MEDICINE_SELECT = {
  id: true,
  name: true,
  quantity: true,
  unit: true,
  expiration_date: true,
} as const satisfies Prisma.medicine_itemsSelect;

export const VISIT_MEDICINE_SELECT = {
  id: true,
  medicine_id: true,
  name: true,
  unit: true,
  dose_per_time: true,
  times_per_day: true,
  medication_timings: true,
  usage_note: true,
  sort_order: true,
  medicine_items: {
    select: CABINET_MEDICINE_SELECT,
  },
} as const satisfies Prisma.visit_medicinesSelect;

export const VISIT_SUMMARY_SELECT = {
  id: true,
  visit_date: true,
  initial_visit_id: true,
  hospital_name: true,
  department: true,
  doctor_name: true,
  symptom_tags: true,
  symptom_note: true,
  diagnosis: true,
  advice: true,
  photo_keys: true,
  version: true,
  created_at: true,
  updated_at: true,
  visit_medicines: {
    select: VISIT_MEDICINE_SELECT,
    orderBy: { sort_order: 'asc' as const },
  },
} as const satisfies Prisma.visit_recordsSelect;

export const VISIT_DETAIL_SELECT = {
  ...VISIT_SUMMARY_SELECT,
  prescription: true,
} as const satisfies Prisma.visit_recordsSelect;

export const INITIAL_VISIT_SUMMARY_SELECT = {
  id: true,
  visit_date: true,
  hospital_name: true,
  diagnosis: true,
  visit_medicines: {
    select: {
      id: true,
      name: true,
      unit: true,
      dose_per_time: true,
      times_per_day: true,
      medication_timings: true,
    },
    orderBy: { sort_order: 'asc' as const },
  },
} as const satisfies Prisma.visit_recordsSelect;

export type VisitMedicineRecord = Prisma.visit_medicinesGetPayload<{
  select: typeof VISIT_MEDICINE_SELECT;
}>;

export type VisitSummaryRecord = Prisma.visit_recordsGetPayload<{
  select: typeof VISIT_SUMMARY_SELECT;
}>;

export type VisitDetailRecord = Prisma.visit_recordsGetPayload<{
  select: typeof VISIT_DETAIL_SELECT;
}>;

export type InitialVisitSummaryRecord = Prisma.visit_recordsGetPayload<{
  select: typeof INITIAL_VISIT_SUMMARY_SELECT;
}>;

export type CabinetMedicineResponse = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  expirationDate: string | null;
};

export type VisitMedicineResponse = {
  id: string;
  medicineId: string | null;
  name: string;
  unit: string;
  dosePerTime: number | null;
  timesPerDay: number | null;
  medicationTimings: string[];
  usageNote: string | null;
  cabinetMedicine: CabinetMedicineResponse | null;
};

export type VisitSummaryResponse = {
  id: string;
  visitDate: string;
  initialVisitId: string | null;
  hospitalName: string | null;
  department: string | null;
  doctorName: string | null;
  symptomTags: string[];
  symptomNote: string | null;
  diagnosis: string | null;
  advice: string | null;
  photoCount: number;
  medicines: VisitMedicineResponse[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type InitialVisitSummaryResponse = {
  id: string;
  visitDate: string;
  hospitalName: string | null;
  diagnosis: string | null;
  medicines: Array<{
    id: string;
    name: string;
    unit: string;
    dosePerTime: number | null;
    timesPerDay: number | null;
    medicationTimings: string[];
  }>;
};

export type VisitDetailResponse = VisitSummaryResponse & {
  prescription: string | null;
  photos: [];
  initialVisit: InitialVisitSummaryResponse | null;
};

function toDecimalNumber(
  value: { toNumber(): number } | null | undefined,
): number | null {
  return value ? value.toNumber() : null;
}

export function toVisitMedicineResponse(
  item: VisitMedicineRecord,
): VisitMedicineResponse {
  return {
    id: item.id,
    medicineId: item.medicine_id,
    name: item.name,
    unit: item.unit,
    dosePerTime: toDecimalNumber(item.dose_per_time),
    timesPerDay: item.times_per_day,
    medicationTimings: item.medication_timings,
    usageNote: item.usage_note,
    cabinetMedicine: item.medicine_items
      ? {
          id: item.medicine_items.id,
          name: item.medicine_items.name,
          quantity: item.medicine_items.quantity,
          unit: item.medicine_items.unit,
          expirationDate: item.medicine_items.expiration_date
            ? formatDateOnly(item.medicine_items.expiration_date)
            : null,
        }
      : null,
  };
}

export function toVisitSummaryResponse(
  item: VisitSummaryRecord,
): VisitSummaryResponse {
  return {
    id: item.id,
    visitDate: formatDateOnly(item.visit_date),
    initialVisitId: item.initial_visit_id,
    hospitalName: item.hospital_name,
    department: item.department,
    doctorName: item.doctor_name,
    symptomTags: item.symptom_tags,
    symptomNote: item.symptom_note,
    diagnosis: item.diagnosis,
    advice: item.advice,
    photoCount: item.photo_keys.length,
    medicines: item.visit_medicines.map(toVisitMedicineResponse),
    version: item.version,
    createdAt: item.created_at.toISOString(),
    updatedAt: item.updated_at.toISOString(),
  };
}

export function toInitialVisitSummaryResponse(
  item: InitialVisitSummaryRecord,
): InitialVisitSummaryResponse {
  return {
    id: item.id,
    visitDate: formatDateOnly(item.visit_date),
    hospitalName: item.hospital_name,
    diagnosis: item.diagnosis,
    medicines: item.visit_medicines.map((med) => ({
      id: med.id,
      name: med.name,
      unit: med.unit,
      dosePerTime: toDecimalNumber(med.dose_per_time),
      timesPerDay: med.times_per_day,
      medicationTimings: med.medication_timings,
    })),
  };
}

export function toVisitDetailResponse(
  item: VisitDetailRecord,
  initialVisit: InitialVisitSummaryRecord | null,
): VisitDetailResponse {
  return {
    ...toVisitSummaryResponse(item),
    prescription: item.prescription,
    photos: [],
    initialVisit: initialVisit
      ? toInitialVisitSummaryResponse(initialVisit)
      : null,
  };
}
