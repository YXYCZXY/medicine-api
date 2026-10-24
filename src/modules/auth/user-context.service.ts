import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';

type Identity = { userId: string | null; sessionId: string | null };

@Injectable()
export class UserContextService {
  private readonly storage = new AsyncLocalStorage<Identity>();

  run(next: () => void): void {
    this.storage.run({ userId: null, sessionId: null }, next);
  }

  set(userId: string, sessionId: string): void {
    const identity = this.storage.getStore();
    if (!identity) throw new UnauthorizedException('请求身份不可用');
    identity.userId = userId;
    identity.sessionId = sessionId;
  }

  getUserId(): string {
    const userId = this.storage.getStore()?.userId;
    if (!userId) throw new UnauthorizedException('请先登录');
    return userId;
  }

  getSessionId(): string {
    const sessionId = this.storage.getStore()?.sessionId;
    if (!sessionId) throw new UnauthorizedException('请先登录');
    return sessionId;
  }
}

@Injectable()
export class UserContextMiddleware implements NestMiddleware {
  constructor(private readonly context: UserContextService) {}

  use(_request: unknown, _response: unknown, next: () => void): void {
    this.context.run(next);
  }
}
