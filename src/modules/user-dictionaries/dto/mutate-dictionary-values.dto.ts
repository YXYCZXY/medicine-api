import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';

import { trimUniqueStrings } from '../../medicines/dto/transforms.js';

/**
 * 向指定字典属性追加或移除标签
 */
export class MutateDictionaryValuesDto {
  @Transform(trimUniqueStrings)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(50, { each: true })
  values!: string[];
}
