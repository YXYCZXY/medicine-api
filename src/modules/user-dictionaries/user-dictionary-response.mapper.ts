import type { Prisma } from '../../generated/prisma/client.js';

import type { DictionaryField } from './dto/dictionary-field.js';

export const USER_DICTIONARY_SELECT = {
  id: true,
  categories: true,
  efficacies: true,
  symptoms: true,
  created_at: true,
  updated_at: true,
} as const satisfies Prisma.user_dictionariesSelect;

export type UserDictionaryRecord = Prisma.user_dictionariesGetPayload<{
  select: typeof USER_DICTIONARY_SELECT;
}>;

export type UserDictionaryResponse = {
  id: string;
  categories: string[];
  efficacies: string[];
  symptoms: string[];
  createdAt: string;
  updatedAt: string;
};

export type UserDictionaryFieldResponse = {
  [K in DictionaryField]?: string[];
};

export function toUserDictionaryResponse(
  item: UserDictionaryRecord,
): UserDictionaryResponse {
  return {
    id: item.id,
    categories: item.categories,
    efficacies: item.efficacies,
    symptoms: item.symptoms,
    createdAt: item.created_at.toISOString(),
    updatedAt: item.updated_at.toISOString(),
  };
}

export function toUserDictionaryFieldResponse(
  field: DictionaryField,
  values: string[],
): UserDictionaryFieldResponse {
  return { [field]: values };
}
