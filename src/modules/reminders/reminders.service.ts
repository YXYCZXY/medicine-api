import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { createCabinetMedicine } from '../medicines/create-cabinet-medicine.js';
import {
  BUSINESS_TIME_ZONE,
  formatDateOnly,
  toDateOnlyUtc,
  todayInBusinessTz,
} from '../visits/visit-date.js';
import {
  CreateReminderDto,
  ReminderFieldsDto,
  ReminderMedicineDto,
  UpdateExpiryDto,
  UpdateReminderDto,
} from './dto/reminder.dto.js';
import { QueryBloodPressureDto, UpdateCheckinDto } from './dto/checkin.dto.js';
import {
  getOccurrenceDate,
  toBloodPressureResponse,
  toExpiryResponse,
  toReminderResponse,
  type ReminderRecord,
} from './reminder-response.mapper.js';

const CONFLICT = '记录已变化，请重新读取后确认';
const EXPIRING_VALID_DAYS = 15;
type Tx = Prisma.TransactionClient;

/** 按业务时区处理提醒规则、打卡与临期操作，写操作由数据库事务串行化。 */
@Injectable()
export class RemindersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** 用户身份只取自服务端，开发期沿用现有开发用户配置。 */
  private getUserId(): string {
    return this.config.getOrThrow<string>('DEV_USER_ID');
  }

  /** 提醒不存在或不属于当前用户时统一隐藏资源。 */
  private async loadReminder(
    tx: Tx,
    userId: string,
    id: string,
  ): Promise<ReminderRecord> {
    const row = await tx.health_reminders.findFirst({
      where: { id, user_id: userId },
      include: { medicine: true },
    });
    if (!row) throw new NotFoundException('提醒不存在');
    return row;
  }

  /** 同一提醒的编辑、删除和打卡先锁主记录，避免删除后仍保存测量。 */
  private async lockReminder(
    tx: Tx,
    userId: string,
    id: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM health_reminders WHERE id = ${id}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
  }

  /** 唯一键冲突和事务竞争作为可重新读取的版本冲突返回。 */
  private rethrowWriteError(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (['P2002', 'P2034'].includes(error.code) ||
        error.message.includes('40P01'))
    ) {
      throw new ConflictException(CONFLICT);
    }
    throw error;
  }

  /** 校验合并后的类型、时间和药品组合，不为缺少的业务字段补默认值。 */
  private validateFields(type: string, fields: ReminderFieldsDto): void {
    if (!fields.title) throw new BadRequestException('请填写提醒事项');
    if (!fields.frequency) throw new BadRequestException('请选择重复频次');
    if (type === 'visit') {
      if (fields.frequency !== 'once' || fields.time != null)
        throw new BadRequestException('复查就医只支持指定日期，不支持提醒时刻');
    } else if (!fields.time) {
      throw new BadRequestException('请填写提醒时刻');
    }
    if (fields.frequency === 'once') {
      if (!fields.date) throw new BadRequestException('请填写提醒日期');
    } else if (fields.date != null) {
      throw new BadRequestException('重复提醒不能指定单次日期');
    }
    if (type !== 'daily' && fields.recordBloodPressure)
      throw new BadRequestException('只有日常提醒可以记录血压');
    if (type !== 'med' && fields.medicine !== undefined)
      throw new BadRequestException('只有用药提醒可以关联药品');
  }

  /** 写入独立快照；关联已有药品时锁定其外键，新增入箱沿用共用事务函数。 */
  private async writeMedicine(
    tx: Tx,
    userId: string,
    id: string,
    medicine: ReminderMedicineDto,
  ): Promise<void> {
    let medicineId = medicine.medicineId;
    if (medicineId && medicine.cabinet)
      throw new BadRequestException('已关联药箱药品时不能同时传入入箱信息');
    if (medicineId) {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM medicine_items WHERE id = ${medicineId}::uuid AND user_id = ${userId}::uuid FOR KEY SHARE`;
      if (rows.length === 0)
        throw new BadRequestException('所选药箱药品不存在或不可访问');
    } else if (medicine.cabinet) {
      medicineId = await createCabinetMedicine(tx, userId, medicine);
    }
    const data = {
      medicine_id: medicineId,
      name: medicine.name,
      unit: medicine.unit,
      dose_per_time: medicine.dosePerTime ?? null,
      times_per_day: medicine.timesPerDay ?? null,
      medication_timings: medicine.medicationTimings ?? [],
    };
    await tx.health_reminder_medicines.upsert({
      where: { reminder_id: id },
      create: { reminder_id: id, ...data },
      update: data,
    });
  }

  /** 只读取当前规则对应的那次打卡，不把旧日期的完成状态带到新日期。 */
  private async loadResponse(
    tx: Tx,
    userId: string,
    id: string,
    today: string,
  ) {
    const row = await this.loadReminder(tx, userId, id);
    const occurrenceDate = getOccurrenceDate(row, today);
    const checkin = occurrenceDate
      ? await tx.health_reminder_checkins.findUnique({
          where: {
            reminder_id_occurrence_date: {
              reminder_id: id,
              occurrence_date: toDateOnlyUtc(occurrenceDate),
            },
          },
          include: { blood_pressure: true },
        })
      : null;
    return toReminderResponse(row, checkin, today);
  }

  /** 仅查询有库存且进入 15 个有效天数窗口的药品，不在读取时写入状态。 */
  private async loadExpiryItems(tx: Tx, userId: string, today: string) {
    const lastDay = toDateOnlyUtc(today);
    lastDay.setUTCDate(lastDay.getUTCDate() + EXPIRING_VALID_DAYS - 1);
    const rows = await tx.medicine_items.findMany({
      where: {
        user_id: userId,
        quantity: { gt: 0 },
        expiration_date: { lte: lastDay },
      },
      include: { medicine_expiry_states: true },
      orderBy: [{ expiration_date: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => toExpiryResponse(row, today));
  }

  /** 全部计划用于管理；今日计数只包含今天执行的计划，临期单列。 */
  async findAll() {
    const userId = this.getUserId();
    const today = todayInBusinessTz();
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.health_reminders.findMany({
          where: { user_id: userId },
          include: { medicine: true },
        });
        const occurrences = rows
          .map((row) => ({ id: row.id, date: getOccurrenceDate(row, today) }))
          .filter((item) => item.date !== null);
        const checkins = occurrences.length
          ? await tx.health_reminder_checkins.findMany({
              where: {
                OR: occurrences.map((item) => ({
                  reminder_id: item.id,
                  occurrence_date: toDateOnlyUtc(item.date!),
                })),
              },
              include: { blood_pressure: true },
            })
          : [];
        const byReminder = new Map(
          checkins.map((row) => [row.reminder_id, row]),
        );
        const reminders = rows.map((row) =>
          toReminderResponse(row, byReminder.get(row.id) ?? null, today),
        );
        const expiry = (await this.loadExpiryItems(tx, userId, today)).filter(
          (item) => item.status !== 'dismissed',
        );
        const todayItems = reminders.filter(
          (item) => item.occurrenceDate === today,
        );
        const lastWatchDay = toDateOnlyUtc(today);
        lastWatchDay.setUTCDate(lastWatchDay.getUTCDate() + 7);
        const watchItems = [
          ...reminders
            .filter(
              (item) =>
                item.frequency === 'once' &&
                !item.done &&
                item.date! > today &&
                item.date! <= formatDateOnly(lastWatchDay),
            )
            .map((item) => ({
              type: item.type,
              reminderId: item.id,
              medicineId: null as string | null,
              date: item.date!,
              title: item.title,
              subtitle: item.note,
              tone: 'default',
            })),
          ...expiry
            .filter((item) => !item.done)
            .map((item) => ({
              type: item.type,
              reminderId: null as string | null,
              medicineId: item.medicineId,
              date: item.expirationDate,
              title: item.title,
              subtitle: item.advice,
              tone: 'error',
            })),
        ].sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            `${a.reminderId ?? a.medicineId}`.localeCompare(
              `${b.reminderId ?? b.medicineId}`,
            ),
        );
        const items = [
          ...reminders.map((item) => ({
            item,
            rank: item.done
              ? 2
              : ['upcoming', 'not_scheduled'].includes(item.status)
                ? 1
                : 0,
            date: item.occurrenceDate ?? today,
            time: item.time ?? '',
            key: item.id,
          })),
          ...expiry.map((item) => ({
            item,
            rank: item.done ? 2 : 0,
            date: item.expirationDate,
            time: '',
            key: item.medicineId,
          })),
        ]
          .sort(
            (a, b) =>
              a.rank - b.rank ||
              a.date.localeCompare(b.date) ||
              a.time.localeCompare(b.time) ||
              a.key.localeCompare(b.key),
          )
          .map((entry) => entry.item);
        return {
          date: today,
          timeZone: BUSINESS_TIME_ZONE,
          summary: {
            pendingCount: todayItems.filter((item) => !item.done).length,
            doneCount: todayItems.filter((item) => item.done).length,
            expiryCount: expiry.filter((item) => !item.done).length,
          },
          watchCount: watchItems.length,
          watchItems: watchItems.slice(0, 2),
          items,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /** 返回提醒及当前执行日的打卡、血压与独立版本。 */
  async findOne(id: string) {
    return this.prisma.$transaction((tx) =>
      this.loadResponse(tx, this.getUserId(), id, todayInBusinessTz()),
    );
  }

  /** 同一事务创建提醒、药品快照及可选药箱记录。 */
  async create(dto: CreateReminderDto) {
    const userId = this.getUserId();
    const today = todayInBusinessTz();
    const frequency =
      dto.frequency ?? (dto.type === 'visit' ? 'once' : undefined);
    this.validateFields(dto.type, {
      title: dto.title,
      frequency,
      date: dto.date,
      time: dto.time,
      recordBloodPressure: dto.recordBloodPressure,
      medicine: dto.medicine,
    });
    if (dto.date && dto.date < today)
      throw new BadRequestException('提醒日期不能早于今天');
    if (dto.type === 'med' && !dto.medicine)
      throw new BadRequestException('请选择提醒药品');
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.health_reminders.create({
          data: {
            id: dto.id,
            user_id: userId,
            type: dto.type,
            title: dto.title!,
            note: dto.note ?? null,
            frequency: frequency!,
            remind_date: dto.date ? toDateOnlyUtc(dto.date) : null,
            remind_time: dto.time ?? null,
            starts_on: toDateOnlyUtc(today),
            record_blood_pressure: dto.recordBloodPressure ?? false,
          },
        });
        if (dto.medicine)
          await this.writeMedicine(tx, userId, dto.id, dto.medicine);
        return this.loadResponse(tx, userId, dto.id, today);
      });
    } catch (error) {
      this.rethrowWriteError(error);
    }
  }

  /** 编辑合并后校验完整组合；已完成记录和历史测量不因规则编辑而删除。 */
  async update(id: string, dto: UpdateReminderDto) {
    const userId = this.getUserId();
    const today = todayInBusinessTz();
    const { expectedVersion, ...fields } = dto;
    if (Object.values(fields).every((value) => value === undefined))
      throw new BadRequestException('没有需要修改的内容');
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockReminder(tx, userId, id);
        const current = await this.loadReminder(tx, userId, id);
        if (current.version !== expectedVersion)
          throw new ConflictException(CONFLICT);
        const scheduleChanged =
          fields.frequency !== undefined ||
          fields.date !== undefined ||
          fields.time !== undefined;
        if (
          scheduleChanged &&
          (fields.frequency === undefined ||
            fields.date === undefined ||
            fields.time === undefined)
        ) {
          throw new BadRequestException(
            '修改时间规则时请同时提供频次、日期和时刻',
          );
        }
        const merged = {
          title: fields.title ?? current.title,
          frequency:
            fields.frequency ??
            (current.frequency as 'daily' | 'weekdays' | 'once'),
          date:
            fields.date !== undefined
              ? fields.date
              : current.remind_date
                ? formatDateOnly(current.remind_date)
                : null,
          time: fields.time !== undefined ? fields.time : current.remind_time,
          recordBloodPressure:
            fields.recordBloodPressure ?? current.record_blood_pressure,
          medicine: fields.medicine,
        };
        this.validateFields(current.type, merged);
        if (
          fields.date &&
          fields.date !==
            (current.remind_date
              ? formatDateOnly(current.remind_date)
              : null) &&
          fields.date < today
        ) {
          throw new BadRequestException('提醒日期不能早于今天');
        }
        await tx.health_reminders.update({
          where: { id },
          data: {
            title: merged.title,
            frequency: merged.frequency,
            remind_date: merged.date ? toDateOnlyUtc(merged.date) : null,
            remind_time: merged.time,
            record_blood_pressure: merged.recordBloodPressure,
            ...(fields.note !== undefined ? { note: fields.note } : {}),
            version: { increment: 1 },
          },
        });
        if (fields.medicine)
          await this.writeMedicine(tx, userId, id, fields.medicine);
        return this.loadResponse(tx, userId, id, today);
      });
    } catch (error) {
      this.rethrowWriteError(error);
    }
  }

  /** 删除规则与打卡；数据库 SET NULL 保留血压，药箱药品不受影响。 */
  async remove(id: string, expectedVersion: number): Promise<void> {
    const userId = this.getUserId();
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lockReminder(tx, userId, id);
        const current = await this.loadReminder(tx, userId, id);
        if (current.version !== expectedVersion)
          throw new ConflictException(CONFLICT);
        await tx.health_reminders.delete({ where: { id } });
      });
    } catch (error) {
      this.rethrowWriteError(error);
    }
  }

  /** 按明确的目标状态写入；血压和打卡同时成功或同时回滚。 */
  async updateCheckin(
    id: string,
    occurrenceDate: string,
    dto: UpdateCheckinDto,
  ) {
    const userId = this.getUserId();
    const today = todayInBusinessTz();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockReminder(tx, userId, id);
        const reminder = await this.loadReminder(tx, userId, id);
        if (reminder.version !== dto.expectedReminderVersion)
          throw new ConflictException(CONFLICT);
        if (
          getOccurrenceDate(reminder, today) !== occurrenceDate ||
          occurrenceDate > today
        )
          throw new BadRequestException('该日期不能打卡');
        const key = {
          reminder_id: id,
          occurrence_date: toDateOnlyUtc(occurrenceDate),
        };
        const current = await tx.health_reminder_checkins.findUnique({
          where: { reminder_id_occurrence_date: key },
        });
        if ((current?.version ?? 0) !== dto.expectedVersion)
          throw new ConflictException(CONFLICT);
        if (
          dto.completed &&
          reminder.record_blood_pressure &&
          !dto.bloodPressure
        )
          throw new BadRequestException('请填写血压测量记录');
        if (
          dto.bloodPressure &&
          (!dto.completed || !reminder.record_blood_pressure)
        )
          throw new BadRequestException('本次操作不支持保存血压');
        if (
          dto.bloodPressure &&
          new Date(dto.bloodPressure.measuredAt).getTime() > Date.now()
        )
          throw new BadRequestException('测量时间不能晚于当前时间');
        const checkin = await tx.health_reminder_checkins.upsert({
          where: { reminder_id_occurrence_date: key },
          create: {
            ...key,
            scheduled_time: reminder.remind_time,
            completed_at: dto.completed ? new Date() : null,
          },
          update: {
            completed_at: dto.completed ? new Date() : null,
            version: { increment: 1 },
          },
        });
        if (dto.bloodPressure) {
          const bp = dto.bloodPressure;
          const data = {
            systolic: bp.systolic,
            diastolic: bp.diastolic,
            pulse: bp.pulse,
            slot: bp.slot,
            measured_at: new Date(bp.measuredAt),
          };
          await tx.blood_pressure_records.upsert({
            where: { checkin_id: checkin.id },
            create: { user_id: userId, checkin_id: checkin.id, ...data },
            update: data,
          });
        }
        return this.loadResponse(tx, userId, id, today);
      });
    } catch (error) {
      this.rethrowWriteError(error);
    }
  }

  /** 临期详情只接受药箱当前有效期及当前监控窗口。 */
  async findExpiry(id: string, expirationDate: string) {
    return this.prisma.$transaction(async (tx) => {
      const today = todayInBusinessTz();
      const lastDay = toDateOnlyUtc(today);
      lastDay.setUTCDate(lastDay.getUTCDate() + EXPIRING_VALID_DAYS - 1);
      const medicine = await tx.medicine_items.findFirst({
        where: {
          id,
          user_id: this.getUserId(),
          quantity: { gt: 0 },
          expiration_date: {
            equals: toDateOnlyUtc(expirationDate),
            lte: lastDay,
          },
        },
        include: { medicine_expiry_states: true },
      });
      if (!medicine) throw new NotFoundException('临期提醒不存在');
      return toExpiryResponse(medicine, today);
    });
  }

  /** 处理状态绑定药品和有效期；锁药箱后检查版本，避免操作覆盖换新后的有效期。 */
  async updateExpiry(id: string, dto: UpdateExpiryDto) {
    const userId = this.getUserId();
    const today = todayInBusinessTz();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM medicine_items WHERE id = ${id}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
        if (locked.length === 0) throw new NotFoundException('药品不存在');
        const medicine = await tx.medicine_items.findFirstOrThrow({
          where: { id, user_id: userId },
          include: { medicine_expiry_states: true },
        });
        if (
          !medicine.expiration_date ||
          formatDateOnly(medicine.expiration_date) !== dto.expirationDate
        )
          throw new ConflictException('药品有效期已变化，请重新读取');
        const lastDay = toDateOnlyUtc(today);
        lastDay.setUTCDate(lastDay.getUTCDate() + EXPIRING_VALID_DAYS - 1);
        if (medicine.quantity <= 0 || medicine.expiration_date > lastDay)
          throw new BadRequestException('药品当前不在临期监控范围');
        const response = toExpiryResponse(medicine, today);
        if (response.version !== dto.expectedVersion)
          throw new ConflictException(CONFLICT);
        const data = {
          handled_at: dto.status === 'handled' ? new Date() : null,
          dismissed_at: dto.status === 'dismissed' ? new Date() : null,
        };
        const key = {
          medicine_id: id,
          expiration_date: toDateOnlyUtc(dto.expirationDate),
        };
        const state = await tx.medicine_expiry_states.upsert({
          where: { medicine_id_expiration_date: key },
          create: { ...key, ...data },
          update: { ...data, version: { increment: 1 } },
        });
        return toExpiryResponse(
          { ...medicine, medicine_expiry_states: [state] },
          today,
        );
      });
    } catch (error) {
      this.rethrowWriteError(error);
    }
  }

  /** 独立查询测量；删除提醒后无需依赖原提醒授权，仍按测量所属用户隔离。 */
  async findBloodPressure(query: QueryBloodPressureDto) {
    if (query.fromDate && query.toDate && query.fromDate > query.toDate)
      throw new BadRequestException('开始日期不能晚于结束日期');
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const end = query.toDate
      ? new Date(`${query.toDate}T00:00:00+08:00`)
      : null;
    if (end) end.setTime(end.getTime() + 86400000);
    const where: Prisma.blood_pressure_recordsWhereInput = {
      user_id: this.getUserId(),
      measured_at: {
        ...(query.fromDate
          ? { gte: new Date(`${query.fromDate}T00:00:00+08:00`) }
          : {}),
        ...(end ? { lt: end } : {}),
      },
    };
    return this.prisma.$transaction(
      async (tx) => {
        const total = await tx.blood_pressure_records.count({ where });
        const rows = await tx.blood_pressure_records.findMany({
          where,
          include: { checkin: true },
          orderBy: [{ measured_at: 'desc' }, { id: 'asc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        });
        return {
          items: rows.map(toBloodPressureResponse),
          page,
          pageSize,
          total,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
