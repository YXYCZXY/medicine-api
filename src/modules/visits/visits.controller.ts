import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { CreateVisitDto } from './dto/create-visit.dto.js';
import { DeleteVisitQueryDto } from './dto/delete-visit-query.dto.js';
import { QueryVisitsDto } from './dto/query-visits.dto.js';
import { UpdateVisitDto } from './dto/update-visit.dto.js';
import { VisitsService } from './visits.service.js';

const visitIdPipe = new ParseUUIDPipe({
  version: '4',
  exceptionFactory: () => new BadRequestException('就诊 ID 格式不正确'),
});

@Controller('visits')
export class VisitsController {
  constructor(private readonly visitsService: VisitsService) {}

  /**
   * 就诊分页列表
   * GET /visits
   */
  @Get()
  findAll(@Query() query: QueryVisitsDto) {
    return this.visitsService.findAll(query);
  }

  /**
   * 就诊详情
   * GET /visits/:id
   */
  @Get(':id')
  findOne(@Param('id', visitIdPipe) id: string) {
    return this.visitsService.findOne(id);
  }

  /**
   * 新增就诊
   * POST /visits
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateVisitDto) {
    return this.visitsService.create(dto);
  }

  /**
   * 修改就诊
   * PATCH /visits/:id
   */
  @Patch(':id')
  update(
    @Param('id', visitIdPipe) id: string,
    @Body() dto: UpdateVisitDto,
  ) {
    return this.visitsService.update(id, dto);
  }

  /**
   * 删除就诊
   * DELETE /visits/:id?expectedVersion=N
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', visitIdPipe) id: string,
    @Query() query: DeleteVisitQueryDto,
  ): Promise<void> {
    await this.visitsService.remove(id, query.expectedVersion);
  }
}
