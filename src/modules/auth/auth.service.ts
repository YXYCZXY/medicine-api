import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../database/prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { hashPassword, verifyPassword } from './password.js';
import { UserContextService } from './user-context.service.js';

const SESSION_AGE_SECONDS = 7 * 24 * 60 * 60;

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

type PublicUser = { id: string; account: string; nickname: string; phone: string | null; avatar_url: string | null };

function publicUser(user: PublicUser) {
  return { id: user.id, account: user.account, nickname: user.nickname, phone: user.phone, avatarUrl: user.avatar_url };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: UserContextService,
  ) {}

  private async createSession(user: PublicUser, client: Prisma.TransactionClient | PrismaService = this.prisma) {
    const token = randomBytes(32).toString('base64url');
    await client.user_sessions.create({ data: {
      user_id: user.id,
      token_hash: tokenHash(token),
      expires_at: new Date(Date.now() + SESSION_AGE_SECONDS * 1000),
    } });
    return { token, expiresIn: SESSION_AGE_SECONDS, user: publicUser(user) };
  }

  async register(accountInput: string, password: string, nicknameInput: string) {
    const account = accountInput.trim().toLowerCase();
    const nickname = nicknameInput.trim();
    if (!nickname) throw new ConflictException('请填写昵称');
    const passwordHash = await hashPassword(password);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.users.create({ data: {
          account,
          password_hash: passwordHash,
          nickname,
        } });
        return this.createSession(user, tx);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('账号已被注册');
      }
      throw error;
    }
  }

  async login(accountInput: string, password: string) {
    const account = accountInput.trim().toLowerCase();
    const user = await this.prisma.users.findUnique({ where: { account } });
    if (!user || user.status !== 'active' || !(await verifyPassword(password, user.password_hash))) {
      throw new UnauthorizedException('账号或密码错误');
    }
    await this.prisma.users.update({ where: { id: user.id }, data: { last_login_at: new Date() } });
    return this.createSession(user);
  }

  async authenticate(token: string): Promise<{ userId: string; sessionId: string } | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = await this.prisma.user_sessions.findUnique({
      where: { token_hash: tokenHash(token) },
      include: { user: true },
    });
    if (!session || session.revoked_at || session.expires_at <= new Date() || session.user.status !== 'active') return null;
    return { userId: session.user_id, sessionId: session.id };
  }

  async logout(): Promise<void> {
    await this.prisma.user_sessions.updateMany({
      where: { id: this.context.getSessionId(), revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  async me() {
    const user = await this.prisma.users.findUnique({ where: { id: this.context.getUserId() } });
    if (!user || user.status !== 'active') throw new UnauthorizedException('请先登录');
    return publicUser(user);
  }
}
