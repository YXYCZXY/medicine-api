import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { Prisma } from '../../generated/prisma/client.js';

const CHECK_VIOLATION_SQLSTATE = '23514';

/**
 * 驱动适配器把未单独映射的 PostgreSQL 错误归为 P2039，原始 SQLSTATE 只能从 meta 或 message 中取得
 */
function isCheckViolation(
  error: Prisma.PrismaClientKnownRequestError,
): boolean {
  const meta = error.meta as
    | { driverAdapterError?: { cause?: { originalCode?: string } } }
    | undefined;

  return (
    meta?.driverAdapterError?.cause?.originalCode ===
      CHECK_VIOLATION_SQLSTATE ||
    error.message.includes(`\`${CHECK_VIOLATION_SQLSTATE}\``)
  );
}

function toHttpError(
  error: Prisma.PrismaClientKnownRequestError,
): [HttpStatus, string] | undefined {
  switch (error.code) {
    case 'P2000':
      return [HttpStatus.BAD_REQUEST, '字段长度超出限制'];
    case 'P2003':
      return [HttpStatus.BAD_REQUEST, '关联数据不存在或已被删除'];
    case 'P2020':
      return [HttpStatus.BAD_REQUEST, '数值超出允许范围'];
    case 'P2025':
      return [HttpStatus.NOT_FOUND, '数据不存在或已被删除'];
    default:
      return isCheckViolation(error)
        ? [HttpStatus.BAD_REQUEST, '数据不符合取值要求']
        : undefined;
  }
}

/**
 * 将 Prisma 已知错误映射为业务状态码，避免直接返回 500
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(
    exception: Prisma.PrismaClientKnownRequestError,
    host: ArgumentsHost,
  ) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const mapped = toHttpError(exception);

    if (!mapped) {
      this.logger.error(
        `未处理的 Prisma 错误 ${exception.code}: ${exception.message}`,
      );
    }

    const [statusCode, message] = mapped ?? [
      HttpStatus.INTERNAL_SERVER_ERROR,
      '服务器内部错误',
    ];

    void reply.status(statusCode).send({ statusCode, message });
  }
}
