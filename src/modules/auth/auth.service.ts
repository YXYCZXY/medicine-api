import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service.js';
import { DEFAULT_USER_DICTIONARY } from './default-user-dictionary.js';
import { UserContextService } from './user-context.service.js';
import { SupabaseIdentityService, SupabaseJwtVerifier, type VerifiedIdentity } from './supabase-auth.js';
import { lockUserWrites } from '../user-dictionaries/dictionary-actions.js';
import { Prisma } from '../../generated/prisma/client.js';
import { lockActiveAccount } from './account-write-lock.js';

type Profile = { id: string; nickname: string; phone: string; avatar_url: string | null; status: string };
function publicUser(user: Profile) {
  return { id: user.id, nickname: user.nickname, phone: user.phone, avatarUrl: user.avatar_url, status: user.status };
}
function assertActive(user: Profile) {
  if (user.status !== 'active') throw new ForbiddenException({ code: user.status === 'deleting' ? 'ACCOUNT_DELETING' : 'ACCOUNT_DISABLED', message: user.status === 'deleting' ? '账号正在删除中' : '账号已停用' });
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: UserContextService,
    private readonly verifier: SupabaseJwtVerifier,
    private readonly identities: SupabaseIdentityService,
  ) {}

  async authenticate(token: string) {
    const identity = await this.verifier.verify(token);
    await this.ensureBusinessUser(identity, token);
    return identity;
  }

  async ensureBusinessUser(identity: VerifiedIdentity, token: string) {
    // Existing access JWTs remain cryptographically valid after Auth deletion.
    // Check the remote identity on every authenticated request, without caching it.
    await this.identities.getVerifiedUser(token, identity);
    const existing = await this.prisma.users.findUnique({
      where: { id: identity.userId }, include: { dictionary: { select: { id: true } } },
    });
    if (existing) {
      assertActive(existing);
      if (existing.phone !== identity.phone) throw new ForbiddenException({ code: 'PHONE_MISMATCH', message: '账号手机号发生变化，请重新登录' });
      if (existing.dictionary) return;
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockUserWrites(tx, identity.userId);
        let user = await tx.users.findUnique({ where: { id: identity.userId } });
        if (!user) {
          // Recheck AFTER the same lock used by deletion. A late bootstrap must
          // never recreate an identity that disappeared while it waited.
          const verified = await this.identities.getVerifiedUser(token, identity);
          user = await tx.users.create({ data: {
            id: identity.userId, phone: verified.phone, phone_verified_at: verified.confirmedAt,
            nickname: verified.nickname,
          } });
        }
        assertActive(user);
        if (user.phone !== identity.phone) throw new ForbiddenException({ code: 'PHONE_MISMATCH', message: '账号手机号不一致' });
        await tx.user_dictionaries.upsert({
          where: { user_id: user.id }, update: {},
          create: { user_id: user.id,
            categories: [...DEFAULT_USER_DICTIONARY.categories],
            efficacies: [...DEFAULT_USER_DICTIONARY.efficacies],
            symptoms: [...DEFAULT_USER_DICTIONARY.symptoms],
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: 'PHONE_ALREADY_BOUND', message: '该手机号已绑定其他身份，请联系客服' });
      }
      throw error;
    }
  }

  async me() {
    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: this.context.getUserId() } });
    assertActive(user);
    return publicUser(user);
  }

  async updateNickname(nickname: string) {
    const userId = this.context.getUserId();
    return this.prisma.$transaction(async tx => {
      await lockActiveAccount(tx, userId);
      return publicUser(await tx.users.update({ where: { id: userId }, data: { nickname } }));
    });
  }
}
