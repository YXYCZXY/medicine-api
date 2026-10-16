import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

import { trimString } from '../../medicines/dto/transforms.js';

@ValidatorConstraint({ name: 'initialOnlyXorInitialVisitId', async: false })
class InitialOnlyXorInitialVisitIdConstraint
  implements ValidatorConstraintInterface
{
  validate(_: unknown, args: ValidationArguments): boolean {
    const obj = args.object as QueryVisitsDto;
    if (obj.initialOnly === true && obj.initialVisitId) {
      return false;
    }
    return true;
  }

  defaultMessage(): string {
    return 'initialOnly 与 initialVisitId 不能同时使用';
  }
}

function toOptionalBoolean({ value }: { value: unknown }): unknown {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  return value;
}

export class QueryVisitsDto {
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(9999)
  year?: number;

  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @Validate(InitialOnlyXorInitialVisitIdConstraint)
  initialOnly?: boolean;

  @IsOptional()
  @IsUUID('4')
  initialVisitId?: string;

  @IsOptional()
  @IsUUID('4')
  excludeId?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  onOrBefore?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}
