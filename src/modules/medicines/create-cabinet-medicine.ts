import type { Prisma } from '../../generated/prisma/client.js';
import { applyDictionaryActionsInTx } from '../user-dictionaries/dictionary-actions.js';
import { normalizeDictionaryActions } from '../user-dictionaries/dto/dictionary-action.dto.js';
import type { CreateCabinetMedicineDto } from './dto/create-cabinet-medicine.dto.js';

type CabinetMedicineInput = {
  name: string;
  unit: string;
  dosePerTime?: number | null;
  timesPerDay?: number | null;
  medicationTimings?: string[];
  cabinet?: CreateCabinetMedicineDto;
};

/** 在调用方事务内保存大类文本并入箱，提醒或就诊保存失败时一并回滚。 */
export async function createCabinetMedicine(
  tx: Prisma.TransactionClient,
  userId: string,
  medicine: CabinetMedicineInput,
): Promise<string> {
  const cabinet = medicine.cabinet!;
  const created = await tx.medicine_items.create({
    data: {
      ...(cabinet.id ? { id: cabinet.id } : {}),
      user_id: userId,
      category: cabinet.category,
      name: medicine.name,
      quantity: cabinet.quantity,
      unit: medicine.unit,
      expiration_date: cabinet.expirationDate
        ? new Date(`${cabinet.expirationDate}T00:00:00.000Z`)
        : null,
      efficacy: cabinet.efficacyTags ?? [],
      dose_per_time: medicine.dosePerTime ?? null,
      times_per_day: medicine.timesPerDay ?? null,
      medication_timings: medicine.medicationTimings ?? [],
      location: cabinet.locationId ?? null,
      note: cabinet.note ?? null,
    },
    select: { id: true },
  });
  await applyDictionaryActionsInTx(
    tx,
    userId,
    normalizeDictionaryActions(cabinet.dictionaryActions),
  );
  return created.id;
}
