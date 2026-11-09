import { Controller, Inject, Module, Post, Req, Res } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../auth/public.decorator.js';
import { AliyunSmsSender, SMS_FETCH } from './aliyun-sms.sender.js';
import { SmsHookError, SmsHookService } from './sms-hook.service.js';

@Controller('hooks/supabase')
export class SmsHookController {
  constructor(@Inject(SmsHookService) private readonly hook: SmsHookService) {}

  @Public()
  @Post('send-sms')
  async send(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Res() reply: FastifyReply,
  ) {
    try {
      await this.hook.handle(req.rawBody, req.headers);
      return reply.status(200).send({});
    } catch (error) {
      const status = error instanceof SmsHookError ? error.status : 500;
      const message =
        error instanceof SmsHookError
          ? error.message
          : 'SMS service unavailable';
      return reply
        .status(status)
        .send({ error: { http_code: status, message } });
    }
  }
}

@Module({
  controllers: [SmsHookController],
  providers: [
    SmsHookService,
    AliyunSmsSender,
    { provide: SMS_FETCH, useValue: fetch },
  ],
})
export class SmsHookModule {}
