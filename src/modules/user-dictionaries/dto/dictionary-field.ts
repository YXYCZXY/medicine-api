import { BadRequestException, PipeTransform } from '@nestjs/common';

export const DICTIONARY_FIELDS = [
  'categories',
  'efficacies',
  'symptoms',
] as const;

export type DictionaryField = (typeof DICTIONARY_FIELDS)[number];

export function isDictionaryField(value: string): value is DictionaryField {
  return (DICTIONARY_FIELDS as readonly string[]).includes(value);
}

export class ParseDictionaryFieldPipe implements PipeTransform<string, DictionaryField> {
  transform(value: string): DictionaryField {
    if (!isDictionaryField(value)) {
      throw new BadRequestException('字典字段不正确');
    }
    return value;
  }
}
