import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsDefined,
  IsIn,
  IsInt,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class BloodPressureDto {
  @IsInt()
  @Min(1)
  @Max(32767)
  systolic!: number;

  @IsInt()
  @Min(1)
  @Max(32767)
  diastolic!: number;

  @IsInt()
  @Min(1)
  @Max(32767)
  pulse!: number;

  @IsIn(['morning', 'afternoon', 'bedtime'])
  slot!: 'morning' | 'afternoon' | 'bedtime';

  @IsDateString({ strict: true })
  @Matches(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
  )
  measuredAt!: string;
}

export class UpdateCheckinDto {
  @IsInt()
  @Min(1)
  expectedReminderVersion!: number;

  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @IsBoolean()
  completed!: boolean;

  @ValidateIf((_, value) => value !== undefined)
  @IsDefined()
  @ValidateNested()
  @Type(() => BloodPressureDto)
  bloodPressure?: BloodPressureDto;
}

export class QueryBloodPressureDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  fromDate?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  toDate?: string;

  @ValidateIf((_, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // 按每页最多 100 条限制页码，避免 Prisma skip 超出 32 位整数。
  @Max(21474836)
  page?: number;

  @ValidateIf((_, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
