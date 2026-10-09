import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';

import { MedicinesService } from './medicines.service.js';

import { CreateMedicineDto } from './dto/create-medicine.dto.js';
import { UpdateMedicineDto } from './dto/update-medicine.dto.js';

@Controller('medicines')
export class MedicinesController {
  constructor(
    private readonly medicinesService: MedicinesService,
  ) {}

  /**
   * 获取全部药品分类
   * GET /medicines/categories
   */
  @Get('categories')
  findCategories() {
    return this.medicinesService.findCategories();
  }

  /**
   * 获取药品列表
   * GET /medicines
   */
  @Get()
  findAll() {
    return this.medicinesService.findAll();
  }

  /**
   * 新增药品
   * POST /medicines
   */
  @Post()
  create(@Body() dto: CreateMedicineDto) {
    return this.medicinesService.create(dto);
  }

  /**
   * 修改药品
   * PATCH /medicines/:id
   */
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' }))
    id: string,
    @Body() dto: UpdateMedicineDto,
  ) {
    return this.medicinesService.update(id, dto);
  }

  /**
   * 删除药品
   * DELETE /medicines/:id
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '4' }))
    id: string,
  ): Promise<void> {
    await this.medicinesService.remove(id);
  }
}