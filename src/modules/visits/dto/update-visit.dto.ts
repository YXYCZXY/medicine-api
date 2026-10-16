import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Validate,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform } from 'class-transformer';

import {
  trimToNull,
  trimUniqueStrings,
} from '../../medicines/dto/transforms.js';

import {
  UniqueVisitMedicineIdsConstraint,
  UniqueVisitMedicineMedicineIdsConstraint,
  VisitDateNotFutureConstraint,
} from './create-visit.dto.js';
import { VisitMedicineDto } from './visit-medicine.dto.js';

export class UpdateVisitDto {
  @IsInt()
  @IsPositive()
  expectedVersion!: number;

  @ValidateIf((_, value) => value !== undefined)
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @Validate(VisitDateNotFutureConstraint)
  visitDate?: string;

  /** null 表示改为初诊；非空 UUID 由服务端归一，且不得等于本条 id */
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsUUID('4')
  initialVisitId?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(150)
  hospitalName?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(20)
  department?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(20)
  doctorName?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @Transform(trimUniqueStrings)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(50, { each: true })
  symptomTags?: string[];

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(200)
  symptomNote?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(50)
  diagnosis?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(500)
  prescription?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(2000)
  advice?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => VisitMedicineDto)
  @Validate(UniqueVisitMedicineIdsConstraint)
  @Validate(UniqueVisitMedicineMedicineIdsConstraint)
  medicines?: VisitMedicineDto[];
}
