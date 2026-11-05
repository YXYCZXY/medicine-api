import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { trimString } from '../../medicines/dto/transforms.js';

/**
 * 重命名指定字典属性中的单个标签
 */
export class RenameDictionaryValueDto {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  from!: string;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  to!: string;
}
