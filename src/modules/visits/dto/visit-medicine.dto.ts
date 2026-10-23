import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { Transform } from 'class-transformer';

import {
  trimString,
  trimToNull,
  trimUniqueStrings,
} from '../../medicines/dto/transforms.js';

import { CreateCabinetMedicineDto } from '../../medicines/dto/create-cabinet-medicine.dto.js';

@ValidatorConstraint({ name: 'cabinetRequiresNullMedicineId', async: false })
class CabinetRequiresNullMedicineIdConstraint
  implements ValidatorConstraintInterface
{
  validate(_: unknown, args: ValidationArguments): boolean {
    const obj = args.object as VisitMedicineDto;
    if (obj.cabinet === undefined) {
      return true;
    }
    return obj.medicineId === null;
  }

  defaultMessage(): string {
    return '已关联药箱药品时不能同时传入入箱信息';
  }
}

export class VisitMedicineDto {
  @IsUUID('4')
  id!: string;

  @ValidateIf((_, value) => value !== null)
  @IsUUID('4')
  medicineId!: string | null;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(100)
  name!: string;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  unit!: string;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(9999.99)
  dosePerTime?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(32767)
  timesPerDay?: number | null;

  @IsOptional()
  @Transform(trimUniqueStrings)
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(50, { each: true })
  medicationTimings?: string[];

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(500)
  usageNote?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateCabinetMedicineDto)
  @Validate(CabinetRequiresNullMedicineIdConstraint)
  cabinet?: CreateCabinetMedicineDto;
}
