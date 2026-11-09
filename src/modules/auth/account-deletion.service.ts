import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../database/prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { lockUserWrites } from '../user-dictionaries/dictionary-actions.js';
import { lockActiveAccount } from './account-write-lock.js';
import { SupabaseAccountAdmin } from './supabase-account-admin.js';
import { UserContextService } from './user-context.service.js';
import type { DeleteAccountDto } from './account-deletion.dto.js';

export const receiptHash = (secret: string) =>
  createHash('sha256').update(secret).digest('hex');
const RECEIPT_TTL = 30 * 24 * 60 * 60 * 1000;
function matches(hash: string, secret: string) {
  return (
    /^[a-f0-9]{64}$/.test(secret) &&
    hash.length === 64 &&
    timingSafeEqual(
      Buffer.from(hash, 'hex'),
      Buffer.from(receiptHash(secret), 'hex'),
    )
  );
}
async function lockOperation(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'account-deletion:' + id}, 0))::text`;
}

@Injectable()
export class AccountDeletionService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | null = null;
  private stopping = false;
  private readonly logger = new Logger(AccountDeletionService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: UserContextService,
    private readonly admin: SupabaseAccountAdmin,
  ) {}

  onModuleInit() {
    if (!this.admin.configured) return;
    this.timer = setInterval(() => this.wake(), 30_000);
    this.timer.unref();
    this.wake();
  }
  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.running;
  }
  private wake() {
    if (!this.stopping)
      void this.drain().catch(() =>
        this.logger.warn({ event: 'account_deletion_worker_unavailable' }),
      );
  }
  async sendCode() {
    this.admin.assertConfigured();
    const userId = this.context.getUserId();
    return this.prisma.$transaction(
      async (tx) => {
        await lockActiveAccount(tx, userId);
        const now = new Date();
        const old = await tx.account_deletion_challenges.findUnique({
          where: { user_id: userId },
        });
        if (old && old.next_send_at > now)
          throw new HttpException(
            {
              code: 'OTP_RATE_LIMITED',
              message: '请等待 60 秒后重新获取验证码',
            },
            429,
          );
        const user = await tx.users.findUniqueOrThrow({
          where: { id: userId },
        });
        await this.admin.sendCode(user.phone);
        await tx.account_deletion_challenges.upsert({
          where: { user_id: userId },
          create: {
            user_id: userId,
            next_send_at: new Date(now.getTime() + 60_000),
            expires_at: new Date(now.getTime() + 5 * 60_000),
          },
          update: {
            next_send_at: new Date(now.getTime() + 60_000),
            expires_at: new Date(now.getTime() + 5 * 60_000),
            attempts: 0,
          },
        });
        return { retryAfterSeconds: 60 };
      },
      { timeout: 20_000 },
    );
  }

  async submit(dto: DeleteAccountDto) {
    this.admin.assertConfigured();
    const userId = this.context.getUserId();
    const result = await this.prisma.$transaction(
      async (tx) => {
        await lockUserWrites(tx, userId);
        await lockOperation(tx, dto.operationId);
        const receipt = await tx.account_deletion_receipts.findUnique({
          where: { id: dto.operationId },
        });
        if (receipt) {
          if (!matches(receipt.secret_hash, dto.receiptSecret))
            throw new ForbiddenException('删除凭据无效');
          if (receipt.status === 'cancelled')
            throw new ConflictException({
              code: 'DELETION_CANCELLED',
              message: '本次删除提交已取消，请重新操作',
            });
          return { accepted: true as const };
        }
        await lockActiveAccount(tx, userId);
        const user = await tx.users.findUniqueOrThrow({
          where: { id: userId },
        });
        const challenge = await tx.account_deletion_challenges.findUnique({
          where: { user_id: userId },
        });
        if (!challenge || challenge.expires_at <= new Date())
          throw new BadRequestException({
            code: 'OTP_REQUIRED',
            message: '请重新获取删除账号验证码',
          });
        if (challenge.attempts >= 5)
          throw new HttpException(
            {
              code: 'OTP_RATE_LIMITED',
              message: '验证次数过多，请重新获取验证码',
            },
            429,
          );
        await tx.account_deletion_challenges.update({
          where: { user_id: userId },
          data: { attempts: { increment: 1 } },
        });
        try {
          await this.admin.verifyCode(userId, user.phone, dto.code);
        } catch (error) {
          // Commit the attempt counter even when OTP verification fails.
          if (error instanceof HttpException) return { error };
          return {
            error: new HttpException(
              {
                code: 'AUTH_UNAVAILABLE',
                message: '验证服务暂不可用，请稍后重试',
              },
              503,
            ),
          };
        }
        await tx.account_deletion_receipts.create({
          data: {
            id: dto.operationId,
            secret_hash: receiptHash(dto.receiptSecret),
            status: 'processing',
          },
        });
        await tx.account_deletion_tasks.create({
          data: { id: dto.operationId, user_id: userId },
        });
        await tx.users.update({
          where: { id: userId },
          data: { status: 'deleting' },
        });
        await tx.account_deletion_challenges.delete({
          where: { user_id: userId },
        });
        return { accepted: true as const };
      },
      { timeout: 25_000 },
    );
    if ('error' in result) throw result.error;
    this.wake();
    return { operationId: dto.operationId, status: 'processing' as const };
  }

  async status(id: string, secret: string) {
    const receipt = await this.prisma.account_deletion_receipts.findUnique({
      where: { id },
    });
    if (
      !receipt ||
      !matches(receipt.secret_hash, secret) ||
      (receipt.expires_at && receipt.expires_at <= new Date())
    )
      throw new NotFoundException({
        code: 'DELETION_RECEIPT_NOT_FOUND',
        message: '尚未找到该次删除提交，请重新确认处理进度',
      });
    return {
      operationId: id,
      status: receipt.status as 'processing' | 'completed' | 'cancelled',
    };
  }

  /** Closes the response-loss window: a delayed DELETE cannot commit after cancellation. */
  async cancelUnaccepted(id: string, secret: string) {
    if (!/^[a-f0-9]{64}$/.test(secret))
      throw new ForbiddenException('删除凭据无效');
    return this.prisma.$transaction(async (tx) => {
      await lockOperation(tx, id);
      const receipt = await tx.account_deletion_receipts.findUnique({
        where: { id },
      });
      if (receipt) {
        if (!matches(receipt.secret_hash, secret))
          throw new ForbiddenException('删除凭据无效');
        if (receipt.status !== 'cancelled')
          throw new ConflictException({
            code: 'DELETION_ALREADY_ACCEPTED',
            message: '删除已受理，无法撤销，请继续查询进度',
          });
      } else
        await tx.account_deletion_receipts.create({
          data: {
            id,
            secret_hash: receiptHash(secret),
            status: 'cancelled',
            expires_at: new Date(Date.now() + RECEIPT_TTL),
          },
        });
      return { operationId: id, status: 'cancelled' as const };
    });
  }

  drain(): Promise<void> {
    if (this.running) return this.running;
    const work = this.runBatch();
    this.running = work.finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async runBatch() {
    const now = new Date();
    const jobs = await this.prisma.account_deletion_tasks.findMany({
      where: { next_attempt_at: { lte: now } },
      orderBy: { next_attempt_at: 'asc' },
      take: 10,
    });
    for (const job of jobs) {
      if (this.stopping) return;
      // Atomic lease across multiple server processes. Every stage is idempotent.
      const claim = await this.prisma.account_deletion_tasks.updateMany({
        where: { id: job.id, next_attempt_at: { lte: now } },
        data: {
          next_attempt_at: new Date(Date.now() + 120_000),
          attempts: { increment: 1 },
        },
      });
      if (!claim.count) continue;
      try {
        await this.process(job.id, job.user_id);
      } catch {
        await this.prisma.account_deletion_tasks.updateMany({
          where: { id: job.id },
          data: {
            next_attempt_at: new Date(
              Date.now() +
                Math.min(30_000 * 2 ** Math.min(job.attempts, 5), 900_000),
            ),
          },
        });
        this.logger.warn({
          event: 'account_deletion_retry_scheduled',
          operationId: job.id,
        });
      }
    }
    await this.prisma.account_deletion_receipts.deleteMany({
      where: { expires_at: { lte: new Date() } },
    });
    await this.prisma.account_deletion_challenges.deleteMany({
      where: { expires_at: { lte: new Date() } },
    });
  }

  private async process(id: string, userId: string) {
    await this.prisma.$transaction(
      async (tx) => {
        await lockUserWrites(tx, userId);
        const job = await tx.account_deletion_tasks.findUnique({
          where: { id },
        });
        if (!job || job.stage !== 'business') return;
        const user = await tx.users.findUnique({ where: { id: userId } });
        if (user && user.status !== 'deleting')
          throw new Error('ACCOUNT_NOT_DELETING');
        await tx.blood_pressure_records.deleteMany({
          where: { user_id: userId },
        });
        await tx.visit_records.deleteMany({ where: { user_id: userId } });
        await tx.health_reminders.deleteMany({ where: { user_id: userId } });
        await tx.medicine_items.deleteMany({ where: { user_id: userId } });
        await tx.user_dictionaries.deleteMany({ where: { user_id: userId } });
        await tx.sync_attachments.deleteMany({ where: { user_id: userId } });
        await tx.sync_command_receipts.deleteMany({
          where: { user_id: userId },
        });
        await tx.sync_tombstones.deleteMany({ where: { user_id: userId } });
        await tx.sync_reminder_revisions.deleteMany({
          where: { user_id: userId },
        });
        await tx.account_deletion_challenges.deleteMany({
          where: { user_id: userId },
        });
        await tx.account_deletion_tasks.update({
          where: { id },
          data: { stage: 'storage' },
        });
      },
      { timeout: 30_000 },
    );
    const task = await this.prisma.account_deletion_tasks.findUnique({
      where: { id },
    });
    if (!task) return;
    // Repeat the ownership sweep after failures, including uncertain Auth-delete responses.
    await this.admin.removeStorage(userId);
    await this.admin.deleteIdentity(userId);
    await this.prisma.$transaction(async (tx) => {
      await lockUserWrites(tx, userId);
      if (!(await tx.account_deletion_tasks.findUnique({ where: { id } })))
        return;
      await tx.users.deleteMany({ where: { id: userId, status: 'deleting' } });
      await tx.account_deletion_receipts.update({
        where: { id },
        data: {
          status: 'completed',
          expires_at: new Date(Date.now() + RECEIPT_TTL),
        },
      });
      await tx.account_deletion_tasks.delete({ where: { id } });
    });
  }
}
