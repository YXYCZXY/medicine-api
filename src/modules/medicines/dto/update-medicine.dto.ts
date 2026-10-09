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
  ValidateIf,
} from 'class-validator';

export class UpdateMedicineDto {
  /**
   * 药品名称
   * 可选，但传入时不能为空
   */
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, {
    message: '药品名称不能只包含空格',
  })
  @MaxLength(100)
  name?: string;

  /**
   * 当前库存数量
   * 允许 0，不允许负数、小数或 null
   */
  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(0)
  quantity?: number;

  /**
   * 药品单位
   * GRAIN  - 粒
   * BAG    - 袋
   * BOTTLE - 瓶
   */
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(['GRAIN', 'BAG', 'BOTTLE'])
  unit?: 'GRAIN' | 'BAG' | 'BOTTLE';

  /**
   * 药品规格
   * 传 null 可以清空
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  specification?: string | null;

  /**
   * 有效期 YYYY-MM-DD
   * 传 null 可以清空
   */
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expirationDate?: string | null;

  /**
   * 功效
   */
  @IsOptional()
  @IsString()
  efficacy?: string | null;

  /**
   * 存放位置
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  location?: string | null;

  /**
   * 备注
   */
  @IsOptional()
  @IsString()
  note?: string | null;

  /**
   * 药品分类 ID 列表
   *
   * 不传：保持原有分类
   * []：清空全部分类
   * [id1, id2]：替换为指定分类
   */
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  categoryIds?: string[];
}