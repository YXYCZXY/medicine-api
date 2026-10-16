import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../database/prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';

import { CreateVisitDto } from './dto/create-visit.dto.js';
import { QueryVisitsDto } from './dto/query-visits.dto.js';
import { UpdateVisitDto } from './dto/update-visit.dto.js';
import { VisitMedicineDto } from './dto/visit-medicine.dto.js';
import { formatDateOnly, toDateOnlyUtc } from './visit-date.js';
import {
  INITIAL_VISIT_SUMMARY_SELECT,
  VISIT_DETAIL_SELECT,
  VISIT_SUMMARY_SELECT,
  toVisitDetailResponse,
  toVisitSummaryResponse,
  type VisitDetailResponse,
  type VisitSummaryResponse,
} from './visit-response.mapper.js';

type TxClient = Prisma.TransactionClient;

const VISIT_NOT_FOUND = '就诊记录不存在';
const VERSION_CONFLICT = '记录已变化，请重新读取后确认';
const LINK_UNAVAILABLE = '关联就诊不存在或不可访问';
const MEDICINE_MISSING = '所选药箱药品已不存在';

@Injectable()
export class VisitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private getUserId(): string {
    return this.config.getOrThrow<string>('DEV_USER_ID');
  }

  private isDeadlock(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return false;
    }
    const meta = error.meta as { code?: string } | undefined;
    return meta?.code === '40P01' || error.message.includes('40P01');
  }

  private rethrowWriteError(error: unknown): never {
    if (this.isDeadlock(error)) {
      throw new ConflictException(VERSION_CONFLICT);
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        const target = error.meta?.target;
        const targets = Array.isArray(target)
          ? target.map((item) =>
              typeof item === 'string' ? item : JSON.stringify(item),
            )
          : typeof target === 'string'
            ? [target]
            : [];
        const joined = targets.join(',');
        const message = error.message;

        if (
          joined.includes('visit_records_pkey') ||
          targets.includes('id') ||
          message.includes('visit_records_pkey')
        ) {
          throw new ConflictException(VERSION_CONFLICT);
        }

        if (
          joined.includes('uq_visit_medicines_visit_medicine') ||
          (targets.includes('visit_id') && targets.includes('medicine_id')) ||
          message.includes('uq_visit_medicines_visit_medicine')
        ) {
          throw new BadRequestException('同一就诊不能重复关联同一药箱药品');
        }
      }
    }

    throw error;
  }

  private async lockRows(
    tx: TxClient,
    table: 'visit_records' | 'medicine_items',
    ids: string[],
    mode: 'FOR SHARE' | 'FOR UPDATE' | 'FOR KEY SHARE',
  ): Promise<void> {
    const unique = [...new Set(ids)].filter(Boolean).sort();
    if (unique.length === 0) {
      return;
    }

    const idList = Prisma.join(unique.map((id) => Prisma.sql`${id}::uuid`));

    if (table === 'visit_records') {
      await tx.$queryRaw`
        SELECT id FROM visit_records
        WHERE id IN (${idList})
        ORDER BY id
        ${Prisma.raw(mode)}
      `;
      return;
    }

    await tx.$queryRaw`
      SELECT id FROM medicine_items
      WHERE id IN (${idList})
      ORDER BY id
      ${Prisma.raw(mode)}
    `;
  }

  /**
   * 归一初诊/复诊关联目标，返回应写入的根 UUID
   */
  private async resolveInitialVisitId(
    tx: TxClient,
    userId: string,
    visitId: string,
    selectedId: string,
    visitDate: string,
  ): Promise<string> {
    if (selectedId === visitId) {
      throw new BadRequestException('不能关联到自己');
    }

    await this.lockRows(tx, 'visit_records', [selectedId], 'FOR SHARE');

    const selected = await tx.visit_records.findFirst({
      where: { id: selectedId, user_id: userId },
      select: { id: true, initial_visit_id: true, visit_date: true },
    });

    if (!selected) {
      throw new BadRequestException(LINK_UNAVAILABLE);
    }

    const stored = selected.initial_visit_id ?? selected.id;

    await this.lockRows(tx, 'visit_records', [stored], 'FOR SHARE');

    const root = await tx.visit_records.findFirst({
      where: { id: stored },
      select: {
        id: true,
        user_id: true,
        initial_visit_id: true,
        visit_date: true,
      },
    });

    if (root) {
      if (root.user_id !== userId) {
        throw new BadRequestException(LINK_UNAVAILABLE);
      }
      if (root.initial_visit_id !== null) {
        throw new BadRequestException('关联根必须是初诊');
      }
      if (formatDateOnly(root.visit_date) > visitDate) {
        throw new BadRequestException('复诊日期不能早于初诊日期');
      }
    }

    return stored;
  }

  private async assertCanBecomeFollowup(
    tx: TxClient,
    visitId: string,
  ): Promise<void> {
    const child = await tx.visit_records.findFirst({
      where: { initial_visit_id: visitId },
      select: { id: true },
    });

    if (child) {
      throw new BadRequestException('已被其他就诊关联的初诊不能改为复诊');
    }
  }

  private async assertInitialDateChange(
    tx: TxClient,
    visitId: string,
    newDate: string,
  ): Promise<void> {
    const earliestFollowup = await tx.visit_records.findFirst({
      where: { initial_visit_id: visitId },
      orderBy: { visit_date: 'asc' },
      select: { visit_date: true },
    });

    if (
      earliestFollowup &&
      newDate > formatDateOnly(earliestFollowup.visit_date)
    ) {
      throw new BadRequestException('初诊日期不能晚于同组复诊日期');
    }
  }

  private async assertFollowupDateAgainstRoot(
    tx: TxClient,
    rootId: string,
    newDate: string,
  ): Promise<void> {
    const root = await tx.visit_records.findFirst({
      where: { id: rootId },
      select: { visit_date: true, initial_visit_id: true },
    });

    if (!root) {
      return;
    }

    if (root.initial_visit_id !== null) {
      throw new BadRequestException('关联根必须是初诊');
    }

    if (formatDateOnly(root.visit_date) > newDate) {
      throw new BadRequestException('复诊日期不能早于初诊日期');
    }
  }

  private async assertCategoryExists(
    tx: TxClient,
    categoryId: string,
  ): Promise<void> {
    const category = await tx.medicine_categories.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });

    if (!category) {
      throw new BadRequestException('药品分类不存在');
    }
  }

  private async createCabinetMedicine(
    tx: TxClient,
    userId: string,
    medicine: VisitMedicineDto,
  ): Promise<string> {
    const cabinet = medicine.cabinet!;
    await this.assertCategoryExists(tx, cabinet.categoryId);

    const created = await tx.medicine_items.create({
      data: {
        user_id: userId,
        category_id: cabinet.categoryId,
        name: medicine.name,
        quantity: cabinet.quantity,
        unit: medicine.unit,
        expiration_date: cabinet.expirationDate
          ? toDateOnlyUtc(cabinet.expirationDate)
          : null,
        efficacy: cabinet.efficacyTags ?? [],
        dose_per_time:
          medicine.dosePerTime === undefined || medicine.dosePerTime === null
            ? null
            : medicine.dosePerTime,
        times_per_day:
          medicine.timesPerDay === undefined || medicine.timesPerDay === null
            ? null
            : medicine.timesPerDay,
        medication_timings: medicine.medicationTimings ?? [],
        location: cabinet.locationId ?? null,
        note: cabinet.note ?? null,
      },
      select: { id: true },
    });

    return created.id;
  }

  private async resolveMedicineIdForCreate(
    tx: TxClient,
    userId: string,
    medicine: VisitMedicineDto,
    existingMedicineIds: Set<string>,
  ): Promise<string | null> {
    if (medicine.medicineId) {
      if (!existingMedicineIds.has(medicine.medicineId)) {
        throw new BadRequestException(MEDICINE_MISSING);
      }
      return medicine.medicineId;
    }

    if (medicine.cabinet) {
      return this.createCabinetMedicine(tx, userId, medicine);
    }

    return null;
  }

  private async resolveMedicineIdForUpdate(
    tx: TxClient,
    userId: string,
    medicine: VisitMedicineDto,
    existingById: Map<
      string,
      { id: string; visit_id: string; medicine_id: string | null }
    >,
    existingMedicineIds: Set<string>,
  ): Promise<string | null> {
    const existing = existingById.get(medicine.id);

    if (medicine.medicineId) {
      if (existingMedicineIds.has(medicine.medicineId)) {
        return medicine.medicineId;
      }
      // 已有明细：药箱已删则写 null；新增明细：400
      if (existing) {
        return null;
      }
      throw new BadRequestException(MEDICINE_MISSING);
    }

    if (medicine.cabinet) {
      return this.createCabinetMedicine(tx, userId, medicine);
    }

    return null;
  }

  private async writeMedicines(
    tx: TxClient,
    visitId: string,
    userId: string,
    medicines: VisitMedicineDto[],
    mode: 'create' | 'replace',
  ): Promise<void> {
    const medicineIds = medicines
      .map((item) => item.medicineId)
      .filter((id): id is string => typeof id === 'string');

    await this.lockRows(tx, 'medicine_items', medicineIds, 'FOR KEY SHARE');

    const owned =
      medicineIds.length === 0
        ? []
        : await tx.medicine_items.findMany({
            where: { id: { in: medicineIds }, user_id: userId },
            select: { id: true },
          });
    const existingMedicineIds = new Set(owned.map((item) => item.id));

    let existingById = new Map<
      string,
      { id: string; visit_id: string; medicine_id: string | null }
    >();

    if (mode === 'replace') {
      const existing = await tx.visit_medicines.findMany({
        where: { visit_id: visitId },
        select: { id: true, visit_id: true, medicine_id: true },
      });
      existingById = new Map(existing.map((row) => [row.id, row]));

      for (const medicine of medicines) {
        const row = existingById.get(medicine.id);
        if (row && row.visit_id !== visitId) {
          throw new BadRequestException('用药明细不属于当前就诊');
        }
      }

      // 明细 ID 已属于其他就诊
      const incomingIds = medicines.map((item) => item.id);
      const foreign = await tx.visit_medicines.findMany({
        where: {
          id: { in: incomingIds },
          visit_id: { not: visitId },
        },
        select: { id: true },
      });
      if (foreign.length > 0) {
        throw new BadRequestException('用药明细不属于当前就诊');
      }
    } else {
      const incomingIds = medicines.map((item) => item.id);
      if (incomingIds.length > 0) {
        const collision = await tx.visit_medicines.findFirst({
          where: { id: { in: incomingIds } },
          select: { id: true },
        });
        if (collision) {
          throw new BadRequestException('用药明细不属于当前就诊');
        }
      }
    }

    const resolved: Array<{
      dto: VisitMedicineDto;
      medicineId: string | null;
      sortOrder: number;
    }> = [];

    for (let index = 0; index < medicines.length; index += 1) {
      const dto = medicines[index]!;
      const medicineId =
        mode === 'create'
          ? await this.resolveMedicineIdForCreate(
              tx,
              userId,
              dto,
              existingMedicineIds,
            )
          : await this.resolveMedicineIdForUpdate(
              tx,
              userId,
              dto,
              existingById,
              existingMedicineIds,
            );

      resolved.push({ dto, medicineId, sortOrder: index });
    }

    if (mode === 'replace') {
      const keepIds = new Set(medicines.map((item) => item.id));
      const toDelete = [...existingById.keys()].filter((id) => !keepIds.has(id));
      if (toDelete.length > 0) {
        await tx.visit_medicines.deleteMany({
          where: { id: { in: toDelete }, visit_id: visitId },
        });
      }

      for (const item of resolved) {
        const data = {
          medicine_id: item.medicineId,
          name: item.dto.name,
          unit: item.dto.unit,
          dose_per_time:
            item.dto.dosePerTime === undefined || item.dto.dosePerTime === null
              ? null
              : item.dto.dosePerTime,
          times_per_day:
            item.dto.timesPerDay === undefined || item.dto.timesPerDay === null
              ? null
              : item.dto.timesPerDay,
          medication_timings: item.dto.medicationTimings ?? [],
          usage_note: item.dto.usageNote ?? null,
          sort_order: item.sortOrder,
        };

        if (existingById.has(item.dto.id)) {
          await tx.visit_medicines.update({
            where: { id: item.dto.id },
            data,
          });
        } else {
          await tx.visit_medicines.create({
            data: {
              id: item.dto.id,
              visit_id: visitId,
              ...data,
            },
          });
        }
      }
      return;
    }

    if (resolved.length === 0) {
      return;
    }

    await tx.visit_medicines.createMany({
      data: resolved.map((item) => ({
        id: item.dto.id,
        visit_id: visitId,
        medicine_id: item.medicineId,
        name: item.dto.name,
        unit: item.dto.unit,
        dose_per_time:
          item.dto.dosePerTime === undefined || item.dto.dosePerTime === null
            ? null
            : item.dto.dosePerTime,
        times_per_day:
          item.dto.timesPerDay === undefined || item.dto.timesPerDay === null
            ? null
            : item.dto.timesPerDay,
        medication_timings: item.dto.medicationTimings ?? [],
        usage_note: item.dto.usageNote ?? null,
        sort_order: item.sortOrder,
      })),
    });
  }

  private async loadDetail(
    tx: TxClient | PrismaService,
    userId: string,
    id: string,
  ): Promise<VisitDetailResponse> {
    const record = await tx.visit_records.findFirst({
      where: { id, user_id: userId },
      select: VISIT_DETAIL_SELECT,
    });

    if (!record) {
      throw new NotFoundException(VISIT_NOT_FOUND);
    }

    let initialVisit = null;
    if (record.initial_visit_id) {
      initialVisit = await tx.visit_records.findFirst({
        where: { id: record.initial_visit_id, user_id: userId },
        select: INITIAL_VISIT_SUMMARY_SELECT,
      });
    }

    return toVisitDetailResponse(record, initialVisit);
  }

  async findAll(query: QueryVisitsDto): Promise<{
    items: VisitSummaryResponse[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const userId = this.getUserId();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    const conditions: Prisma.Sql[] = [
      Prisma.sql`v.user_id = ${userId}::uuid`,
    ];

    if (query.year !== undefined) {
      conditions.push(
        Prisma.sql`v.visit_date >= ${`${query.year}-01-01`}::date`,
      );
      conditions.push(
        Prisma.sql`v.visit_date <= ${`${query.year}-12-31`}::date`,
      );
    }

    if (query.initialOnly === true) {
      conditions.push(Prisma.sql`v.initial_visit_id IS NULL`);
    }

    if (query.initialVisitId) {
      conditions.push(
        Prisma.sql`v.initial_visit_id = ${query.initialVisitId}::uuid`,
      );
    }

    if (query.excludeId) {
      conditions.push(Prisma.sql`v.id <> ${query.excludeId}::uuid`);
    }

    if (query.onOrBefore) {
      conditions.push(
        Prisma.sql`v.visit_date <= ${query.onOrBefore}::date`,
      );
    }

    if (query.q) {
      const pattern = `%${query.q}%`;
      conditions.push(Prisma.sql`(
        EXISTS (
          SELECT 1 FROM unnest(v.symptom_tags) AS t(tag)
          WHERE t.tag ILIKE ${pattern}
        )
        OR COALESCE(v.symptom_note, '') ILIKE ${pattern}
        OR COALESCE(v.diagnosis, '') ILIKE ${pattern}
        OR COALESCE(v.hospital_name, '') ILIKE ${pattern}
        OR COALESCE(v.department, '') ILIKE ${pattern}
        OR COALESCE(v.doctor_name, '') ILIKE ${pattern}
        OR EXISTS (
          SELECT 1 FROM visit_medicines vm
          WHERE vm.visit_id = v.id AND vm.name ILIKE ${pattern}
        )
      )`);
    }

    const whereSql = Prisma.join(conditions, ' AND ');

    const countRows = await this.prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(*)::bigint AS total
      FROM visit_records v
      WHERE ${whereSql}
    `;
    const total = Number(countRows[0]?.total ?? 0);

    const idRows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT v.id
      FROM visit_records v
      WHERE ${whereSql}
      ORDER BY v.visit_date DESC, v.created_at DESC, v.id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `;

    const ids = idRows.map((row) => row.id);
    if (ids.length === 0) {
      return { items: [], page, pageSize, total };
    }

    const records = await this.prisma.visit_records.findMany({
      where: { id: { in: ids } },
      select: VISIT_SUMMARY_SELECT,
    });

    const byId = new Map(records.map((row) => [row.id, row]));
    const items = ids
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .map(toVisitSummaryResponse);

    return { items, page, pageSize, total };
  }

  async findOne(id: string): Promise<VisitDetailResponse> {
    return this.loadDetail(this.prisma, this.getUserId(), id);
  }

  async create(dto: CreateVisitDto): Promise<VisitDetailResponse> {
    const userId = this.getUserId();

    try {
      return await this.prisma.$transaction(async (tx) => {
        try {
          await tx.visit_records.create({
            data: {
              id: dto.id,
              user_id: userId,
              visit_date: toDateOnlyUtc(dto.visitDate),
              initial_visit_id: null,
              hospital_name: dto.hospitalName ?? null,
              department: dto.department ?? null,
              doctor_name: dto.doctorName ?? null,
              symptom_tags: dto.symptomTags,
              symptom_note: dto.symptomNote ?? null,
              diagnosis: dto.diagnosis ?? null,
              prescription: dto.prescription ?? null,
              advice: dto.advice ?? null,
              photo_keys: [],
              version: 1,
            },
          });
        } catch (error) {
          this.rethrowWriteError(error);
        }

        let initialVisitId: string | null = null;
        if (dto.initialVisitId) {
          initialVisitId = await this.resolveInitialVisitId(
            tx,
            userId,
            dto.id,
            dto.initialVisitId,
            dto.visitDate,
          );
          await tx.visit_records.update({
            where: { id: dto.id },
            data: { initial_visit_id: initialVisitId },
          });
        }

        await this.writeMedicines(tx, dto.id, userId, dto.medicines, 'create');

        return this.loadDetail(tx, userId, dto.id);
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      this.rethrowWriteError(error);
    }
  }

  async update(id: string, dto: UpdateVisitDto): Promise<VisitDetailResponse> {
    const userId = this.getUserId();
    const {
      expectedVersion,
      medicines,
      initialVisitId: requestedInitial,
      visitDate: requestedDate,
      ...rest
    } = dto;

    const hasBusinessField =
      medicines !== undefined ||
      requestedInitial !== undefined ||
      requestedDate !== undefined ||
      rest.hospitalName !== undefined ||
      rest.department !== undefined ||
      rest.doctorName !== undefined ||
      rest.symptomTags !== undefined ||
      rest.symptomNote !== undefined ||
      rest.diagnosis !== undefined ||
      rest.prescription !== undefined ||
      rest.advice !== undefined;

    if (!hasBusinessField) {
      throw new BadRequestException('没有需要修改的内容');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const needsSelfLock =
          requestedDate !== undefined ||
          (requestedInitial !== undefined && requestedInitial !== null);

        if (needsSelfLock) {
          await this.lockRows(tx, 'visit_records', [id], 'FOR UPDATE');
        }

        const current = await tx.visit_records.findFirst({
          where: { id, user_id: userId },
          select: {
            id: true,
            version: true,
            visit_date: true,
            initial_visit_id: true,
          },
        });

        if (!current) {
          throw new NotFoundException(VISIT_NOT_FOUND);
        }

        if (current.version !== expectedVersion) {
          throw new ConflictException(VERSION_CONFLICT);
        }

        const nextVisitDate = requestedDate ?? formatDateOnly(current.visit_date);
        let nextInitial = current.initial_visit_id;

        if (requestedInitial !== undefined) {
          if (requestedInitial === null) {
            nextInitial = null;
          } else {
            if (requestedInitial === id) {
              throw new BadRequestException('不能关联到自己');
            }

            const normalized = await this.resolveInitialVisitId(
              tx,
              userId,
              id,
              requestedInitial,
              nextVisitDate,
            );

            if (normalized !== current.initial_visit_id) {
              await this.assertCanBecomeFollowup(tx, id);
              nextInitial = normalized;
            }
          }
        }

        // 日期规则
        if (requestedDate !== undefined) {
          if (nextInitial === null) {
            await this.assertInitialDateChange(tx, id, nextVisitDate);
          } else {
            await this.assertFollowupDateAgainstRoot(
              tx,
              nextInitial,
              nextVisitDate,
            );
          }
        } else if (
          requestedInitial !== undefined &&
          nextInitial !== null &&
          nextInitial !== current.initial_visit_id
        ) {
          await this.assertFollowupDateAgainstRoot(
            tx,
            nextInitial,
            nextVisitDate,
          );
        }

        const data: Prisma.visit_recordsUpdateManyMutationInput = {
          version: { increment: 1 },
          updated_at: new Date(),
        };

        if (requestedDate !== undefined) {
          data.visit_date = toDateOnlyUtc(requestedDate);
        }
        if (requestedInitial !== undefined) {
          data.initial_visit_id = nextInitial;
        }
        if (rest.hospitalName !== undefined) {
          data.hospital_name = rest.hospitalName;
        }
        if (rest.department !== undefined) {
          data.department = rest.department;
        }
        if (rest.doctorName !== undefined) {
          data.doctor_name = rest.doctorName;
        }
        if (rest.symptomTags !== undefined) {
          data.symptom_tags = rest.symptomTags;
        }
        if (rest.symptomNote !== undefined) {
          data.symptom_note = rest.symptomNote;
        }
        if (rest.diagnosis !== undefined) {
          data.diagnosis = rest.diagnosis;
        }
        if (rest.prescription !== undefined) {
          data.prescription = rest.prescription;
        }
        if (rest.advice !== undefined) {
          data.advice = rest.advice;
        }

        const updated = await tx.visit_records.updateMany({
          where: { id, user_id: userId, version: expectedVersion },
          data,
        });

        if (updated.count === 0) {
          const stillThere = await tx.visit_records.findFirst({
            where: { id, user_id: userId },
            select: { id: true },
          });
          if (!stillThere) {
            throw new NotFoundException(VISIT_NOT_FOUND);
          }
          throw new ConflictException(VERSION_CONFLICT);
        }

        if (medicines !== undefined) {
          await this.writeMedicines(tx, id, userId, medicines, 'replace');
        }

        return this.loadDetail(tx, userId, id);
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      this.rethrowWriteError(error);
    }
  }

  async remove(id: string, expectedVersion: number): Promise<void> {
    const userId = this.getUserId();

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lockRows(tx, 'visit_records', [id], 'FOR UPDATE');

        const current = await tx.visit_records.findFirst({
          where: { id, user_id: userId },
          select: { id: true, version: true },
        });

        if (!current) {
          throw new NotFoundException(VISIT_NOT_FOUND);
        }

        if (current.version !== expectedVersion) {
          throw new ConflictException(VERSION_CONFLICT);
        }

        const deleted = await tx.visit_records.deleteMany({
          where: { id, user_id: userId, version: expectedVersion },
        });

        if (deleted.count === 0) {
          throw new ConflictException(VERSION_CONFLICT);
        }
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      this.rethrowWriteError(error);
    }
  }
}
