import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import {
  ParseDictionaryFieldPipe,
  type DictionaryField,
} from './dto/dictionary-field.js';
import { MutateDictionaryValuesDto } from './dto/mutate-dictionary-values.dto.js';
import { RenameDictionaryValueDto } from './dto/rename-dictionary-value.dto.js';
import { UserDictionariesService } from './user-dictionaries.service.js';

const fieldPipe = new ParseDictionaryFieldPipe();

@Controller('user-dictionaries')
export class UserDictionariesController {
  constructor(private readonly dictionaries: UserDictionariesService) {}

  /**
   * 获取当前用户完整字典
   * GET /user-dictionaries
   */
  @Get()
  findAll() {
    return this.dictionaries.findAll();
  }

  /**
   * 获取单个字典属性
   * GET /user-dictionaries/:field
   */
  @Get(':field')
  findField(@Param('field', fieldPipe) field: DictionaryField) {
    return this.dictionaries.findField(field);
  }

  /**
   * 向指定属性追加标签
   * POST /user-dictionaries/:field
   */
  @Post(':field')
  addValues(
    @Param('field', fieldPipe) field: DictionaryField,
    @Body() dto: MutateDictionaryValuesDto,
  ) {
    return this.dictionaries.addValues(field, dto);
  }

  /**
   * 从指定属性移除标签
   * DELETE /user-dictionaries/:field
   */
  @Delete(':field')
  removeValues(
    @Param('field', fieldPipe) field: DictionaryField,
    @Body() dto: MutateDictionaryValuesDto,
  ) {
    return this.dictionaries.removeValues(field, dto);
  }

  /**
   * 重命名指定属性中的单个标签
   * PATCH /user-dictionaries/:field
   */
  @Patch(':field')
  renameValue(
    @Param('field', fieldPipe) field: DictionaryField,
    @Body() dto: RenameDictionaryValueDto,
  ) {
    return this.dictionaries.renameValue(field, dto);
  }
}
