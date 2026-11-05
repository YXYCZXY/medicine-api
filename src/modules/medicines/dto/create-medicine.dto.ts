import { Transform, Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsNumber,
  IsPositive,
  IsDateString,
  IsArray,
  ArrayMaxSize,
  Matches,
  Min,
  Max,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { DictionaryActionDto } from '../../user-dictionaries/dto/dictionary-action.dto.js';
import { trimString, trimUniqueStrings } from './transforms.js';

export class CreateMedicineDto {
  // 药品名称
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(100)
  name!: string;

  // 药品大类，保存单个文本标签
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  category!: string;

  // 当前库存数量
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(2147483647)
  quantity!: number;

  // 药品单位，原样保存文本，例如：粒 / 袋 / 瓶 / 支 / 片
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  unit!: string;

  // 有效期 YYYY-MM-DD，null 表示未填写
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expirationDate?: string | null;

  // 单次剂量，对应 NUMERIC(6,2)，null 表示未填写，不代表 0
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(9999.99)
  dosePerTime?: number | null;

  // 频次（一日 N 次），对应 SMALLINT，null 表示未填写
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(32767)
  timesPerDay?: number | null;

  // 功效标签
  @IsOptional()
  @Transform(trimUniqueStrings)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(50, { each: true })
  efficacyTags?: string[];

  // 用药时段，例如：before-meal / after-meal / bedtime / morning
  @IsOptional()
  @Transform(trimUniqueStrings)
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(50, { each: true })
  medicationTimings?: string[];

  // 存放位置标识，例如：living / fridge / portable
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  locationId?: string | null;

  // 备注
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;

  // 本次保存产生的字典增删改，按顺序重放
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => DictionaryActionDto)
  dictionaryActions?: DictionaryActionDto[];
}
