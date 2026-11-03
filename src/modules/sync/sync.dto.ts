import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class SyncCommandDto {
  @IsUUID('4') id!: string;
  @IsString() @MaxLength(150) user_id!: string;
  @IsString() @MaxLength(100) device_id!: string;
  @IsUUID('4') entity_id!: string;
  @IsString() @MaxLength(80) type!: string;
  @IsInt() @Min(1) @Max(100000) schema_version!: number;
  @IsString() @MaxLength(500000) payload!: string;
  @IsOptional() @IsInt() @Min(0) base_version!: number | null;
  @IsOptional() @IsUUID('4') base_op_id!: string | null;
  @IsString() @MaxLength(20000) depends_on!: string;
  @IsDateString({ strict: true }) client_occurred_at!: string;
  @IsInt() @Min(1) @Max(2147483647) sequence!: number;
}

export class SyncBatchDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SyncCommandDto)
  commands!: SyncCommandDto[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  attachmentFailures?: string[];
}

export class SyncQueryDto {
  @IsString() @MaxLength(100) deviceId!: string;
}

export class AiReadinessDto extends SyncQueryDto {
  @IsInt() @Min(0) @Max(2147483647) throughSequence!: number;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10000)
  @IsUUID('4', { each: true })
  resolvedOpIds?: string[];
}

export class AttachmentDto {
  @IsUUID('4') id!: string;
  @IsString() @MaxLength(11184812) base64!: string;
}
