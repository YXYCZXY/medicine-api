import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

/**
 * 将 Nest 内置 HttpException 统一为 { statusCode, message }
 */
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const statusCode = exception.getStatus();
    const body = exception.getResponse();

    let message = exception.message;

    if (typeof body === 'string') {
      message = body;
    } else if (typeof body === 'object' && body !== null && 'message' in body) {
      const raw = (body as { message: unknown }).message;

      if (typeof raw === 'string') {
        message = raw;
      } else if (Array.isArray(raw) && typeof raw[0] === 'string') {
        message = raw[0];
      }
    }

    void reply.status(statusCode).send({ statusCode, message });
  }
}
