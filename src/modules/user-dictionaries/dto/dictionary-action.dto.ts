import { BadRequestException } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import { trimString } from '../../medicines/dto/transforms.js';
import { DICTIONARY_ACTION_FIELDS } from '../dictionary-actions.js';

export class DictionaryActionDto {
  @IsIn(DICTIONARY_ACTION_FIELDS)
  field!: (typeof DICTIONARY_ACTION_FIELDS)[number];

  @IsIn(['add', 'remove', 'rename'])
  op!: 'add' | 'remove' | 'rename';

  @ValidateIf(
    (action: DictionaryActionDto) =>
      action.op === 'add' || action.op === 'remove',
  )
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  value?: string;

  @ValidateIf((action: DictionaryActionDto) => action.op === 'rename')
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  from?: string;

  @ValidateIf((action: DictionaryActionDto) => action.op === 'rename')
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  to?: string;
}

export class MedicineDictionaryActionDto extends DictionaryActionDto {
  @IsIn(['categories', 'efficacies'])
  declare field: 'categories' | 'efficacies';
}

export class VisitDictionaryActionDto extends DictionaryActionDto {
  @IsIn(['symptoms'])
  declare field: 'symptoms';
}

/** 规范化后供业务层使用的字典行为。 */
export type NormalizedDictionaryAction =
  | {
      field: (typeof DICTIONARY_ACTION_FIELDS)[number];
      op: 'add';
      value: string;
    }
  | {
      field: (typeof DICTIONARY_ACTION_FIELDS)[number];
      op: 'remove';
      value: string;
    }
  | {
      field: (typeof DICTIONARY_ACTION_FIELDS)[number];
      op: 'rename';
      from: string;
      to: string;
    };

export function normalizeDictionaryActions(
  actions: DictionaryActionDto[] | undefined,
  allowedFields: readonly DictionaryActionDto['field'][] = DICTIONARY_ACTION_FIELDS,
): NormalizedDictionaryAction[] | undefined {
  if (!actions?.length) return undefined;
  return actions.map((action) => {
    if (!allowedFields.includes(action.field)) {
      throw new BadRequestException('当前业务不允许修改该字典字段');
    }
    if (action.op === 'rename') {
      return {
        field: action.field,
        op: 'rename' as const,
        from: action.from!,
        to: action.to!,
      };
    }
    return {
      field: action.field,
      op: action.op,
      value: action.value!,
    };
  });
}
