import { BadRequestException, ConflictException } from '@nestjs/common';

import type { Prisma } from '../../generated/prisma/client.js';

export const DICTIONARY_ACTION_FIELDS = [
  'categories',
  'efficacies',
  'symptoms',
] as const;

export type DictionaryActionField = (typeof DICTIONARY_ACTION_FIELDS)[number];

export type DictionaryAction =
  | { field: DictionaryActionField; op: 'add'; value: string }
  | { field: DictionaryActionField; op: 'remove'; value: string }
  | { field: DictionaryActionField; op: 'rename'; from: string; to: string };

const MAX_FIELD_VALUES = 50;

export type DictionaryFieldState = {
  categories: string[];
  efficacies: string[];
  symptoms: string[];
};

/** Always acquire before entity row locks; shared by REST and the sync lane. */
export async function lockUserWrites(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))::text`;
}

type DictionaryMutationInput = {
  dictionaryActions?: readonly unknown[];
  medicines?: { cabinet?: { dictionaryActions?: readonly unknown[] } }[];
  medicine?: { cabinet?: { dictionaryActions?: readonly unknown[] } } | null;
};

export async function lockDictionaryForWrite(
  tx: Prisma.TransactionClient,
  userId: string,
  input: DictionaryMutationInput,
): Promise<void> {
  if (
    input.dictionaryActions?.length ||
    input.medicine?.cabinet?.dictionaryActions?.length ||
    input.medicines?.some(
      (medicine) => medicine.cabinet?.dictionaryActions?.length,
    )
  ) {
    await lockUserWrites(tx, userId);
  }
}

/** 按顺序重放行为；缺失的 remove/rename 忽略，不回写药品或就诊原文。 */
export function applyDictionaryActions(
  current: DictionaryFieldState,
  actions: DictionaryAction[],
): DictionaryFieldState {
  const next: DictionaryFieldState = {
    categories: [...current.categories],
    efficacies: [...current.efficacies],
    symptoms: [...current.symptoms],
  };

  for (const action of actions) {
    const values = next[action.field];
    if (action.op === 'add') {
      if (!values.includes(action.value)) {
        if (values.length >= MAX_FIELD_VALUES) {
          throw new BadRequestException(
            `每个字典属性最多 ${MAX_FIELD_VALUES} 个标签`,
          );
        }
        values.push(action.value);
      }
      continue;
    }
    if (action.op === 'remove') {
      const index = values.indexOf(action.value);
      if (index >= 0) values.splice(index, 1);
      continue;
    }
    if (action.from === action.to) {
      throw new BadRequestException('新旧标签不能相同');
    }
    const fromIndex = values.indexOf(action.from);
    if (fromIndex < 0) continue;
    if (values.includes(action.to)) {
      throw new ConflictException('目标标签已存在');
    }
    values[fromIndex] = action.to;
  }

  return next;
}

/** 调用方须在任何实体读写锁之前调用 lockDictionaryForWrite；此处只在同一事务重放动作。 */
export async function applyDictionaryActionsInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  actions: DictionaryAction[] | undefined,
): Promise<void> {
  if (!actions?.length) return;

  const item = await tx.user_dictionaries.findUnique({
    where: { user_id: userId },
    select: { categories: true, efficacies: true, symptoms: true },
  });
  if (!item) {
    throw new BadRequestException('用户字典不存在');
  }

  const next = applyDictionaryActions(
    {
      categories: item.categories,
      efficacies: item.efficacies,
      symptoms: item.symptoms,
    },
    actions,
  );

  await tx.user_dictionaries.update({
    where: { user_id: userId },
    data: {
      categories: next.categories,
      efficacies: next.efficacies,
      symptoms: next.symptoms,
    },
  });
}
