import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

import { trimToNull, trimUniqueStrings } from './transforms.js';

/**
 * 就诊或提醒入箱时的药箱专属字段；药名、单位和剂量取自所在快照。
 */
export class CreateCabinetMedicineDto {
  @IsUUID('4')
  categoryId!: string;

  @IsInt()
  @Min(0)
  quantity!: number;

  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expirationDate?: string | null;

  @IsOptional()
  @Transform(trimUniqueStrings)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(50, { each: true })
  efficacyTags?: string[];

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  locationId?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(500)
  note?: string | null;
}
