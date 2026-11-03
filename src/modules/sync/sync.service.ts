import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { isUUID, validate } from 'class-validator';
import { PrismaService } from '../../database/prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { UserContextService } from '../auth/user-context.service.js';
import { MedicinesService } from '../medicines/medicines.service.js';
import { CreateMedicineDto } from '../medicines/dto/create-medicine.dto.js';
import { VisitsService } from '../visits/visits.service.js';
import { CreateVisitDto } from '../visits/dto/create-visit.dto.js';
import { UpdateVisitDto } from '../visits/dto/update-visit.dto.js';
import { RemindersService } from '../reminders/reminders.service.js';
import {
  CreateReminderDto,
  UpdateExpiryDto,
  UpdateReminderDto,
  OccurrenceDateDto,
} from '../reminders/dto/reminder.dto.js';
import { UpdateCheckinDto } from '../reminders/dto/checkin.dto.js';
import {
  toBloodPressureResponse,
  toReminderResponse,
} from '../reminders/reminder-response.mapper.js';
import { formatDateOnly, todayInBusinessTz } from '../visits/visit-date.js';
import type { SyncCommandDto } from './sync.dto.js';

type Tx = Prisma.TransactionClient;
type Result = {
  opId: string;
  status: 'accepted' | 'rejected';
  entityId: string;
  version: number | null;
  error?: string;
  sequence: number;
  versions?: Record<string, number>;
};
const DIRECTORY = [
  '感冒发烧',
  '止痛',
  '肠胃',
  '过敏',
  '外伤',
  '抗感染',
  '慢性病',
  '其他',
];
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/** A transaction-scoped facade keeps existing domain services inside the receipt transaction. */
export function transactionFacade(tx: Tx): PrismaService {
  return new Proxy(tx, {
    get(target, key) {
      if (key === '$transaction')
        return (callback: (value: Tx) => Promise<unknown>) => callback(tx);
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as PrismaService;
}

async function checked<T extends object>(
  type: new () => T,
  input: unknown,
): Promise<T> {
  const value = plainToInstance(type, input);
  const errors = await validate(value, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });
  if (errors.length)
    throw new BadRequestException('操作内容校验失败，请核对原记录');
  return value;
}

export function commandDigest(command: SyncCommandDto): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        command.id,
        command.user_id,
        command.device_id,
        command.entity_id,
        command.type,
        command.schema_version,
        command.payload,
        command.base_version ?? null,
        command.base_op_id ?? null,
        command.depends_on,
        command.client_occurred_at,
        command.sequence,
      ]),
    )
    .digest('hex');
}

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: UserContextService,
  ) {}

  async snapshot(deviceId: string) {
    return this.prisma.$transaction((tx) => this.readSnapshot(tx, deviceId), {
      isolationLevel: 'RepeatableRead',
      timeout: 30000,
    });
  }

  private async readSnapshot(tx: Tx, deviceId: string) {
    const userId = this.context.getUserId();
    const facade = transactionFacade(tx);
    const medicines = new MedicinesService(facade, this.context);
    const visits = new VisitsService(facade, this.context);
    const visitIds = await tx.visit_records.findMany({
      where: { user_id: userId },
      select: { id: true },
    });
    const rules = await tx.health_reminders.findMany({
      where: { user_id: userId },
      include: { medicine: true },
    });
    const checkins = await tx.health_reminder_checkins.findMany({
      where: { reminder: { user_id: userId } },
      include: { blood_pressure: true },
    });
    const bloodPressure = await tx.blood_pressure_records.findMany({
      where: { user_id: userId },
      include: { checkin: true },
    });
    const expiry = await tx.medicine_expiry_states.findMany({
      where: { medicine: { user_id: userId } },
    });
    const receipts = await tx.sync_command_receipts.findMany({
      where: { user_id: userId, device_id: deviceId },
      orderBy: { sequence: 'asc' },
    });
    return {
      protocolVersion: 2,
      userId,
      complete: true,
      serverTime: new Date().toISOString(),
      categories: await medicines.findCategories(),
      medicines: await medicines.findAll(),
      visits: await Promise.all(visitIds.map((row) => visits.findOne(row.id))),
      reminders: rules.map((row) =>
        toReminderResponse(row, null, todayInBusinessTz()),
      ),
      checkins: checkins.map((row) => ({
        id: row.id,
        reminderId: row.reminder_id,
        occurrenceDate: formatDateOnly(row.occurrence_date),
        version: row.version,
        completedAt: row.completed_at?.toISOString() ?? null,
        scheduledTime: row.scheduled_time,
        stockMedicineId: row.stock_medicine_id,
        stockQuantity: row.stock_quantity?.toNumber() ?? null,
        stockUnit: row.stock_unit,
        bloodPressure: row.blood_pressure
          ? toBloodPressureResponse({ ...row.blood_pressure, checkin: row })
          : null,
      })),
      bloodPressure: bloodPressure.map(toBloodPressureResponse),
      expiry: expiry.map((row) => ({
        id: `${row.medicine_id}:${formatDateOnly(row.expiration_date)}`,
        medicineId: row.medicine_id,
        expirationDate: formatDateOnly(row.expiration_date),
        version: row.version,
        status: row.dismissed_at
          ? 'dismissed'
          : row.handled_at
            ? 'handled'
            : 'pending',
        handledAt: row.handled_at?.toISOString() ?? null,
        dismissedAt: row.dismissed_at?.toISOString() ?? null,
      })),
      results: receipts.map((row) => row.result as unknown as Result),
    };
  }

  async commands(
    commands: SyncCommandDto[],
    attachmentFailures: string[] = [],
  ) {
    if (
      !commands.length ||
      commands.some((c) => c.device_id !== commands[0].device_id)
    )
      throw new BadRequestException('请提交同一设备的操作');
    const userId = this.context.getUserId();
    await this.prisma.$transaction(
      async (tx) => {
        // Serializes retries from overlapping app sessions before reading receipts.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))::text`;
        for (const command of commands) {
          if (command.user_id !== userId)
            throw new BadRequestException('操作账号不匹配');
          const key = { user_id: userId, op_id: command.id };
          const old = await tx.sync_command_receipts.findUnique({
            where: { user_id_op_id: key },
          });
          const digest = commandDigest(command);
          if (old) {
            if (old.digest !== digest)
              throw new ConflictException(
                '同一操作 ID 的内容不一致，原记录已保留',
              );
            continue;
          }
          await tx.$executeRawUnsafe('SAVEPOINT sync_operation');
          let result: Result;
          try {
            if (attachmentFailures.includes(command.id))
              throw new BadRequestException(
                '关联照片未能上传，原就诊记录和照片已保留在本机',
              );
            const version = await this.apply(tx, command);
            result = {
              opId: command.id,
              status: 'accepted',
              entityId: command.entity_id,
              version,
              sequence: command.sequence,
              versions: await this.versions(tx),
            };
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT sync_operation');
          } catch (error) {
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT sync_operation');
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT sync_operation');
            const failure =
              error instanceof Prisma.PrismaClientKnownRequestError &&
              error.code === 'P2002'
                ? new ConflictException('记录标识已存在，原输入已保留')
                : error;
            if (
              !(failure instanceof HttpException) ||
              failure.getStatus() >= 500 ||
              failure.getStatus() === 429
            )
              throw failure;
            result = {
              opId: command.id,
              status: 'rejected',
              entityId: command.entity_id,
              version: null,
              error: failure.message,
              sequence: command.sequence,
            };
          }
          await tx.sync_command_receipts.create({
            data: {
              ...key,
              device_id: command.device_id,
              sequence: command.sequence,
              entity_id: command.entity_id,
              type: command.type,
              digest,
              status: result.status,
              result: json(result),
            },
          });
        }
      },
      { timeout: 30000 },
    );
    // Read all canonical rows and receipts at one post-commit boundary. A lost
    // response is safe because the next retry reads the same immutable receipts.
    return this.snapshot(commands[0].device_id);
  }

  private async category(tx: Tx, categoryId: unknown): Promise<unknown> {
    if (typeof categoryId !== 'string') return categoryId;
    const match = /^31000000-0000-4000-8000-00000000000([1-8])$/.exec(
      categoryId,
    );
    if (!match) return categoryId;
    const category = await tx.medicine_categories.findUnique({
      where: { name: DIRECTORY[Number(match[1]) - 1] },
    });
    if (!category) throw new BadRequestException('药品分类目录尚未准备完成');
    return category.id;
  }

  private async apply(tx: Tx, command: SyncCommandDto): Promise<number | null> {
    if (![1, 2].includes(command.schema_version))
      throw new BadRequestException('操作协议版本暂不支持，原输入已保留');
    const userId = this.context.getUserId();
    const occurred = new Date(command.client_occurred_at);
    if (
      !Number.isFinite(occurred.getTime()) ||
      occurred.getTime() > Date.now() + 300000
    )
      throw new BadRequestException('操作时间无效，请核对设备时间');
    let dependencies: unknown;
    try {
      dependencies = JSON.parse(command.depends_on);
    } catch {
      throw new BadRequestException('操作依赖格式无效');
    }
    if (
      !Array.isArray(dependencies) ||
      dependencies.length > 100 ||
      dependencies.some((id) => typeof id !== 'string' || !isUUID(id, '4'))
    )
      throw new BadRequestException('操作依赖格式无效');
    for (const opId of dependencies as string[]) {
      const previous = await tx.sync_command_receipts.findUnique({
        where: { user_id_op_id: { user_id: userId, op_id: opId } },
      });
      if (!previous || previous.status !== 'accepted')
        throw new ConflictException('前序操作未被云端接受，原输入已保留');
    }
    let version = command.base_version;
    if (command.base_op_id) {
      const previous = await tx.sync_command_receipts.findUnique({
        where: {
          user_id_op_id: { user_id: userId, op_id: command.base_op_id },
        },
      });
      if (!previous || previous.status !== 'accepted')
        throw new ConflictException('前序版本不可用');
      const result = previous.result as unknown as Result;
      const input = JSON.parse(command.payload) as Record<string, unknown>;
      const prefix = command.type.split('.')[0];
      const key =
        prefix === 'checkin'
          ? `checkin:${command.entity_id}:${String(input.occurrenceDate)}`
          : `${prefix}:${command.entity_id}`;
      version =
        result.versions?.[key] ??
        (previous.entity_id === command.entity_id &&
        previous.type.split('.')[0] === prefix
          ? result.version
          : null);
      if (version == null && !command.type.endsWith('.create'))
        throw new ConflictException('前序实体版本不可用');
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(command.payload) as Record<string, unknown>;
    } catch {
      throw new BadRequestException('操作内容格式无效');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new BadRequestException('操作内容格式无效');
    const facade = transactionFacade(tx);
    const medicines = new MedicinesService(facade, this.context);
    const visits = new VisitsService(facade, this.context);
    const reminders = new RemindersService(facade, this.context);
    const kind = command.type.split('.')[0];
    const tombstone = await tx.sync_tombstones.findUnique({
      where: {
        user_id_kind_entity_id: {
          user_id: userId,
          kind,
          entity_id: command.entity_id,
        },
      },
    });
    if (tombstone)
      throw new ConflictException('记录已删除，离线操作已保留供核对');
    if (kind === 'medicine') {
      if (command.type !== 'medicine.create') {
        await tx.$queryRaw`SELECT id FROM medicine_items WHERE id = ${command.entity_id}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
        const existing = await tx.medicine_items.findFirst({
          where: { id: command.entity_id, user_id: userId },
        });
        if (!existing || version == null || existing.version !== version)
          throw new ConflictException('药品版本已变化，原输入已保留');
      }
      if (command.type === 'medicine.delete') {
        await medicines.remove(command.entity_id);
        return null;
      }
      if (!['medicine.create', 'medicine.update'].includes(command.type))
        throw new BadRequestException('不支持的药品操作');
      if ('quantityMinor' in payload) {
        payload.quantity = Number(payload.quantityMinor) / 100;
        payload.dosePerTime =
          payload.dosePerTimeMinor == null
            ? null
            : Number(payload.dosePerTimeMinor) / 100;
        delete payload.quantityMinor;
        delete payload.dosePerTimeMinor;
      }
      payload.categoryId = await this.category(tx, payload.categoryId);
      const dto = await checked(CreateMedicineDto, payload);
      const result =
        command.type === 'medicine.create'
          ? await medicines.create(dto, command.entity_id)
          : await medicines.update(command.entity_id, dto);
      return result.version;
    }
    // Normalize the stable offline directory without changing original command payloads/digests.
    const normalizeMedicine = async (value: unknown) => {
      if (value && typeof value === 'object' && 'cabinet' in value) {
        const cabinet = (value as { cabinet?: Record<string, unknown> })
          .cabinet;
        if (cabinet)
          cabinet.categoryId = await this.category(tx, cabinet.categoryId);
      }
    };
    if (Array.isArray(payload.medicines))
      for (const item of payload.medicines) await normalizeMedicine(item);
    await normalizeMedicine(payload.medicine);
    if (kind === 'visit') {
      const photos: unknown = payload.photos;
      delete payload.photos;
      let photoIds: string[] | undefined;
      if (photos !== undefined) {
        if (
          !Array.isArray(photos) ||
          photos.length > 9 ||
          photos.some(
            (photo) =>
              !photo ||
              typeof photo !== 'object' ||
              typeof (photo as { id?: unknown }).id !== 'string' ||
              !isUUID((photo as { id: string }).id, '4'),
          )
        )
          throw new BadRequestException('照片引用格式无效');
        photoIds = [
          ...new Set(photos.map((photo) => (photo as { id: string }).id)),
        ];
        const count = await tx.sync_attachments.count({
          where: { user_id: userId, id: { in: photoIds } },
        });
        if (count !== photoIds.length)
          throw new BadRequestException('照片尚未上传完成');
      }
      const savePhotos = async () => {
        if (photoIds)
          await tx.visit_records.update({
            where: { id: command.entity_id, user_id: userId },
            data: { photo_keys: photoIds },
          });
      };
      if (command.type === 'visit.create') {
        const saved = await visits.create(
          await checked(CreateVisitDto, { ...payload, id: command.entity_id }),
        );
        await savePhotos();
        return saved.version;
      }
      if (version == null) throw new ConflictException('就诊原版本不可用');
      if (command.type === 'visit.update') {
        const saved = await visits.update(
          command.entity_id,
          await checked(UpdateVisitDto, {
            ...payload,
            expectedVersion: version,
          }),
        );
        await savePhotos();
        return saved.version;
      }
      if (command.type === 'visit.delete') {
        await visits.remove(command.entity_id, version);
        return null;
      }
    }
    if (kind === 'reminder') {
      if (command.type === 'reminder.create') {
        const saved = await reminders.create(
          await checked(CreateReminderDto, {
            ...payload,
            id: command.entity_id,
          }),
          command.client_occurred_at,
        );
        await this.rememberRule(tx, command.entity_id);
        return saved.version;
      }
      if (version == null) throw new ConflictException('提醒原版本不可用');
      await this.rememberRule(tx, command.entity_id);
      if (command.type === 'reminder.update') {
        delete payload.type;
        const saved = await reminders.update(
          command.entity_id,
          await checked(UpdateReminderDto, {
            ...payload,
            expectedVersion: version,
          }),
          command.client_occurred_at,
        );
        await this.rememberRule(tx, command.entity_id);
        return saved.version;
      }
      if (command.type === 'reminder.delete') {
        await reminders.remove(command.entity_id, version);
        return null;
      }
    }
    if (command.type === 'checkin.set') {
      const reminderId = payload.reminderId;
      if (
        reminderId !== command.entity_id ||
        typeof reminderId !== 'string' ||
        typeof payload.occurrenceDate !== 'string'
      )
        throw new BadRequestException('打卡实例无效');
      await checked(OccurrenceDateDto, {
        occurrenceDate: payload.occurrenceDate,
      });
      const row = await tx.health_reminders.findFirst({
        where: { id: reminderId, user_id: userId },
        include: { medicine: true },
      });
      if (!row) throw new ConflictException('提醒已不存在，离线打卡已保留');
      if (row.version !== payload.expectedReminderVersion) {
        const revision = await tx.sync_reminder_revisions.findUnique({
          where: {
            user_id_reminder_id_version: {
              user_id: userId,
              reminder_id: reminderId,
              version: Number(payload.expectedReminderVersion),
            },
          },
        });
        const semantic = (value: typeof row) =>
          JSON.stringify([
            value.type,
            value.frequency,
            value.remind_date,
            value.remind_time,
            value.starts_on,
            value.record_blood_pressure,
            value.medicine
              ? [
                  value.medicine.medicine_id,
                  value.medicine.unit,
                  Number(value.medicine.dose_per_time),
                  value.medicine.times_per_day,
                  value.medicine.medication_timings,
                ]
              : null,
          ]);
        if (
          !revision ||
          semantic(JSON.parse(JSON.stringify(row)) as typeof row) !==
            semantic(revision.record as unknown as typeof row)
        )
          throw new ConflictException('提醒规则已变化，离线打卡已保留');
      }
      const dto = await checked(UpdateCheckinDto, {
        expectedReminderVersion: row.version,
        expectedVersion: version ?? payload.expectedVersion ?? 0,
        completed: payload.completed,
        ...(payload.bloodPressure
          ? { bloodPressure: payload.bloodPressure }
          : {}),
      });
      if (
        (payload.checkinId !== undefined &&
          (typeof payload.checkinId !== 'string' ||
            !isUUID(payload.checkinId, '4'))) ||
        (payload.bloodPressureId !== undefined &&
          (typeof payload.bloodPressureId !== 'string' ||
            !isUUID(payload.bloodPressureId, '4')))
      )
        throw new BadRequestException('打卡记录标识无效');
      await reminders.updateCheckin(
        reminderId,
        payload.occurrenceDate,
        dto,
        command.client_occurred_at,
        {
          id: payload.checkinId as string | undefined,
          bloodPressureId: payload.bloodPressureId as string | undefined,
        },
      );
      const saved = await tx.health_reminder_checkins.findUniqueOrThrow({
        where: {
          reminder_id_occurrence_date: {
            reminder_id: reminderId,
            occurrence_date: new Date(`${payload.occurrenceDate}T00:00:00Z`),
          },
        },
      });
      return saved.version;
    }
    if (command.type === 'expiry.update') {
      const saved = await reminders.updateExpiry(
        command.entity_id,
        await checked(UpdateExpiryDto, {
          ...payload,
          expectedVersion: version ?? 0,
        }),
      );
      return saved.version;
    }
    throw new BadRequestException('不支持的操作类型，原输入已保留');
  }

  private async versions(tx: Tx): Promise<Record<string, number>> {
    const userId = this.context.getUserId();
    const result: Record<string, number> = {};
    for (const row of await tx.medicine_items.findMany({
      where: { user_id: userId },
      select: { id: true, version: true },
    }))
      result[`medicine:${row.id}`] = row.version;
    for (const row of await tx.visit_records.findMany({
      where: { user_id: userId },
      select: { id: true, version: true },
    }))
      result[`visit:${row.id}`] = row.version;
    for (const row of await tx.health_reminders.findMany({
      where: { user_id: userId },
      select: { id: true, version: true },
    }))
      result[`reminder:${row.id}`] = row.version;
    for (const row of await tx.health_reminder_checkins.findMany({
      where: { reminder: { user_id: userId } },
    }))
      result[
        `checkin:${row.reminder_id}:${formatDateOnly(row.occurrence_date)}`
      ] = row.version;
    for (const row of await tx.medicine_expiry_states.findMany({
      where: { medicine: { user_id: userId } },
    }))
      result[`expiry:${row.medicine_id}`] = row.version;
    return result;
  }

  private async rememberRule(tx: Tx, id: string) {
    const row = await tx.health_reminders.findFirst({
      where: { id, user_id: this.context.getUserId() },
      include: { medicine: true },
    });
    if (row)
      await tx.sync_reminder_revisions.upsert({
        where: {
          user_id_reminder_id_version: {
            user_id: row.user_id,
            reminder_id: id,
            version: row.version,
          },
        },
        create: {
          user_id: row.user_id,
          reminder_id: id,
          version: row.version,
          record: json(row),
        },
        update: {},
      });
  }

  async readiness(
    deviceId: string,
    throughSequence: number,
    resolvedOpIds: string[] = [],
  ) {
    const rows = await this.prisma.sync_command_receipts.findMany({
      where: {
        user_id: this.context.getUserId(),
        device_id: deviceId,
        sequence: { lte: throughSequence },
      },
      select: { op_id: true, sequence: true, status: true },
    });
    const resolved = new Set(resolvedOpIds);
    const accepted = new Set(
      rows
        .filter(
          (row) =>
            row.status === 'accepted' ||
            (row.status === 'rejected' && resolved.has(row.op_id)),
        )
        .map((row) => row.sequence),
    );
    // Count plus bounds verifies every sequence, without allocating a huge array from client input.
    const ready =
      accepted.size === throughSequence &&
      (throughSequence === 0 ||
        (accepted.has(1) && accepted.has(throughSequence)));
    return {
      ready,
      throughSequence,
      rejected: rows
        .filter((row) => row.status === 'rejected' && !resolved.has(row.op_id))
        .map((row) => row.sequence),
      dataAsOf: new Date().toISOString(),
      source: 'database',
    };
  }

  async uploadAttachment(id: string, base64: string) {
    if (
      !base64 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) ||
      base64.length % 4 !== 0
    )
      throw new BadRequestException('照片内容无效');
    const content = Buffer.from(base64, 'base64');
    if (!content.length || content.length > 8388608)
      throw new BadRequestException('照片大小不能超过 8 MB');
    const digest = createHash('sha256')
      .update(content.toString('base64'))
      .digest('hex');
    const key = { user_id: this.context.getUserId(), id };
    const old = await this.prisma.sync_attachments.upsert({
      where: { user_id_id: key },
      create: { ...key, digest, content },
      update: {},
    });
    if (old.digest !== digest)
      throw new ConflictException('照片 ID 已对应其他内容，原照片已保留');
    return { id, digest };
  }
  async downloadAttachment(id: string) {
    const row = await this.prisma.sync_attachments.findUnique({
      where: { user_id_id: { user_id: this.context.getUserId(), id } },
    });
    if (!row) throw new BadRequestException('照片不存在或不可访问');
    return {
      id,
      digest: row.digest,
      base64: Buffer.from(row.content).toString('base64'),
    };
  }
}
