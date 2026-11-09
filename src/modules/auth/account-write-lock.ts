import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { lockUserWrites } from '../user-dictionaries/dictionary-actions.js';

/** Every business mutation checks status AFTER the shared account lock. */
export async function lockActiveAccount(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  await lockUserWrites(tx, userId);
  const user = await tx.users.findUnique({
    where: { id: userId },
    select: { status: true },
  });
  if (!user || user.status !== 'active') {
    throw new ForbiddenException({
      code:
        user?.status === 'deleting' ? 'ACCOUNT_DELETING' : 'ACCOUNT_DISABLED',
      message:
        user?.status === 'deleting'
          ? '账号正在删除中'
          : '账号不可用，请重新登录',
    });
  }
}
