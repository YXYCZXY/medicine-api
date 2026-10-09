import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsIn,
  IsDateString,
  IsArray,
  IsUUID,
  ArrayUnique,
  ArrayMaxSize,
  Matches,
  Min,
  MaxLength,
} from 'class-validator';

export class CreateMedicineDto {
  // 药品名称
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  // 当前库存数量
  @IsInt()
  @Min(0)
  quantity!: number;

  // 药品单位：粒 / 袋 / 瓶
  @IsIn(['GRAIN', 'BAG', 'BOTTLE'])
  unit!: 'GRAIN' | 'BAG' | 'BOTTLE';

  // 药品规格
  @IsOptional()
  @IsString()
  @MaxLength(100)
  specification?: string;

  // 有效期
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expirationDate?: string;

  // 功效
  @IsOptional()
  @IsString()
  efficacy?: string;

  // 存放位置
  @IsOptional()
  @IsString()
  @MaxLength(100)
  location?: string;

  // 备注
  @IsOptional()
  @IsString()
  note?: string;

  // 药品分类 ID 列表
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  categoryIds?: string[];
}