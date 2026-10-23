import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { CreateCabinetMedicineDto } from './dto/create-cabinet-medicine.dto.js';

type CabinetMedicineInput = {
  name: string;
  unit: string;
  dosePerTime?: number | null;
  timesPerDay?: number | null;
  medicationTimings?: string[];
  cabinet?: CreateCabinetMedicineDto;
};

/** 在调用方事务内校验分类并入箱，提醒或就诊保存失败时一并回滚。 */
export async function createCabinetMedicine(
  tx: Prisma.TransactionClient,
  userId: string,
  medicine: CabinetMedicineInput,
): Promise<string> {
  const cabinet = medicine.cabinet!;
  const category = await tx.medicine_categories.findUnique({
    where: { id: cabinet.categoryId },
    select: { id: true },
  });
  if (!category) throw new BadRequestException('药品分类不存在');
  const created = await tx.medicine_items.create({
    data: {
      user_id: userId,
      category_id: cabinet.categoryId,
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
  return created.id;
}
