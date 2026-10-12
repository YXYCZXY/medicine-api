import { Transform } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsNumber,
  IsPositive,
  IsDateString,
  IsArray,
  IsUUID,
  ArrayMaxSize,
  Matches,
  Min,
  Max,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import { trimString, trimUniqueStrings } from './transforms.js';

export class UpdateMedicineDto {
  /**
   * 药品名称
   * 可选，但传入时不能为空
   */
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(100)
  name?: string;

  /**
   * 药品分类 ID
   * 可选，传入时必须是存在的预置分类，不能为 null
   */
  @ValidateIf((_, value) => value !== undefined)
  @IsUUID('4')
  categoryId?: string;

  /**
   * 当前库存数量
   * 允许 0，不允许负数、小数或 null
   */
  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(0)
  quantity?: number;

  /**
   * 药品单位，原样保存文本
   * 可选，但传入时不能为空或 null
   */
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  unit?: string;

  /**
   * 有效期 YYYY-MM-DD
   * 传 null 可以清空
   */
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expirationDate?: string | null;

  /**
   * 单次剂量
   * 传 null 可以清空
   */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(9999.99)
  dosePerTime?: number | null;

  /**
   * 频次（一日 N 次）
   * 传 null 可以清空
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(32767)
  timesPerDay?: number | null;

  /**
   * 功效标签
   * 不传：保持不变；[]：清空
   */
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trimUniqueStrings)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(50, { each: true })
  efficacyTags?: string[];

  /**
   * 用药时段
   * 不传：保持不变；[]：清空
   */
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trimUniqueStrings)
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(50, { each: true })
  medicationTimings?: string[];

  /**
   * 存放位置标识
   * 传 null 可以清空
   */
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  locationId?: string | null;

  /**
   * 备注
   * 传 null 可以清空
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}
