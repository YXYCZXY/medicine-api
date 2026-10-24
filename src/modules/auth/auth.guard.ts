import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { UserContextService } from './user-context.service.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService, private readonly context: UserContextService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(), context.getClass(),
    ])) return true;

    const header = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>()
      .headers.authorization;
    const match = /^Bearer (\S+)$/i.exec(header ?? '');
    const identity = match ? await this.auth.authenticate(match[1]) : null;
    if (!identity) {
      throw new UnauthorizedException('请先登录');
    }
    this.context.set(identity.userId, identity.sessionId);
    return true;
  }
}
