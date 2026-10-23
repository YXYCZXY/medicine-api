import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  IsDateString,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  trimString,
  trimToNull,
  trimUniqueStrings,
} from '../../medicines/dto/transforms.js';
import { CreateCabinetMedicineDto } from '../../medicines/dto/create-cabinet-medicine.dto.js';

export class ReminderMedicineDto {
  @IsDefined()
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
  @Matches(/\S/)
  @MaxLength(20)
  unit!: string;

  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999.99)
  dosePerTime?: number | null;

  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(1)
  @Max(32767)
  timesPerDay?: number | null;

  @ValidateIf((_, value) => value !== undefined)
  @Transform(trimUniqueStrings)
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(50, { each: true })
  medicationTimings?: string[];

  @ValidateIf((_, value) => value !== undefined)
  @IsDefined()
  @ValidateNested()
  @Type(() => CreateCabinetMedicineDto)
  cabinet?: CreateCabinetMedicineDto;
}

/** 创建和编辑共用字段；组合规则在合并当前记录后校验。 */
export class ReminderFieldsDto {
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(200)
  title?: string;

  @ValidateIf((_, value) => value !== undefined && value !== null)
  @Transform(trimToNull)
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsIn(['daily', 'weekdays', 'once'])
  frequency?: 'daily' | 'weekdays' | 'once';

  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string | null;

  @ValidateIf((_, value) => value !== undefined && value !== null)
  @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
  time?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  recordBloodPressure?: boolean;

  @ValidateIf((_, value) => value !== undefined)
  @IsDefined()
  @ValidateNested()
  @Type(() => ReminderMedicineDto)
  medicine?: ReminderMedicineDto;
}

export class CreateReminderDto extends ReminderFieldsDto {
  @IsUUID('4')
  id!: string;

  @IsIn(['med', 'daily', 'visit'])
  type!: 'med' | 'daily' | 'visit';
}

export class UpdateReminderDto extends ReminderFieldsDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class ReminderVersionQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class OccurrenceDateDto {
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  occurrenceDate!: string;
}

export class ExpiryDateQueryDto {
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expirationDate!: string;
}

export class UpdateExpiryDto extends ExpiryDateQueryDto {
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @IsIn(['pending', 'handled', 'dismissed'])
  status!: 'pending' | 'handled' | 'dismissed';
}
