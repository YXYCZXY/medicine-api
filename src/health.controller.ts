import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PrismaService } from './database/prisma/prisma.service.js';
import { Public } from './modules/auth/public.decorator.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async check(@Res({ passthrough: true }) reply: FastifyReply) {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      reply.code(503);
      return { status: 'unavailable' };
    }
  }
}
