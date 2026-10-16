import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsDefined,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { Transform } from 'class-transformer';

import {
  trimToNull,
  trimUniqueStrings,
} from '../../medicines/dto/transforms.js';
import { isVisitDateNotAfterToday } from '../visit-date.js';

import { VisitMedicineDto } from './visit-medicine.dto.js';

@ValidatorConstraint({ name: 'visitDateNotFuture', async: false })
class VisitDateNotFutureConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isVisitDateNotAfterToday(value);
  }

  defaultMessage(): string {
    return '就诊日期不能晚于今天';
  }
}

@ValidatorConstraint({ name: 'initialVisitNotSelf', async: false })
class InitialVisitNotSelfConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value === null || value === undefined) {
      return true;
    }
    const obj = args.object as CreateVisitDto;
    return value !== obj.id;
  }

  defaultMessage(): string {
    return '不能关联到自己';
  }
}

@ValidatorConstraint({ name: 'uniqueVisitMedicineIds', async: false })
class UniqueVisitMedicineIdsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (!Array.isArray(value)) {
      return true;
    }

    const ids = value
      .map((item) =>
        item && typeof item === 'object' && 'id' in item
          ? (item as { id: unknown }).id
          : undefined,
      )
      .filter((id): id is string => typeof id === 'string');

    return new Set(ids).size === ids.length;
  }

  defaultMessage(): string {
    return '用药明细 ID 不能重复';
  }
}

@ValidatorConstraint({ name: 'uniqueVisitMedicineMedicineIds', async: false })
class UniqueVisitMedicineMedicineIdsConstraint
  implements ValidatorConstraintInterface
{
  validate(value: unknown): boolean {
    if (!Array.isArray(value)) {
      return true;
    }

    const medicineIds = value
      .map((item) =>
        item && typeof item === 'object' && 'medicineId' in item
          ? (item as { medicineId: unknown }).medicineId
          : undefined,
      )
      .filter((id): id is string => typeof id === 'string');

    return new Set(medicineIds).size === medicineIds.length;
  }

  defaultMessage(): string {
    return '同一就诊不能重复关联同一药箱药品';
  }
}

export class CreateVisitDto {
  @IsUUID('4')
  id!: string;

  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @Validate(VisitDateNotFutureConstraint)
  visitDate!: string;

  @IsDefined()
  @ValidateIf((_, value) => value !== null)
  @IsUUID('4')
  @Validate(InitialVisitNotSelfConstraint)
  initialVisitId!: string | null;

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

  @Transform(trimUniqueStrings)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(50, { each: true })
  symptomTags!: string[];

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

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => VisitMedicineDto)
  @Validate(UniqueVisitMedicineIdsConstraint)
  @Validate(UniqueVisitMedicineMedicineIdsConstraint)
  medicines!: VisitMedicineDto[];
}

// re-export for UpdateVisitDto reuse of constraints
export {
  VisitDateNotFutureConstraint,
  InitialVisitNotSelfConstraint,
  UniqueVisitMedicineIdsConstraint,
  UniqueVisitMedicineMedicineIdsConstraint,
};
