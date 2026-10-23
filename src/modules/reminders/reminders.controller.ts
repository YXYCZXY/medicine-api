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
import { IsUUID } from 'class-validator';
import {
  CreateReminderDto,
  ExpiryDateQueryDto,
  OccurrenceDateDto,
  ReminderVersionQueryDto,
  UpdateExpiryDto,
  UpdateReminderDto,
} from './dto/reminder.dto.js';
import { UpdateCheckinDto } from './dto/checkin.dto.js';
import { RemindersService } from './reminders.service.js';

const idPipe = new ParseUUIDPipe({
  version: '4',
  exceptionFactory: () => new BadRequestException('ID 格式不正确'),
});

/** 完整路由参数包含 id，参与全局白名单校验。 */
class CheckinParamsDto extends OccurrenceDateDto {
  @IsUUID('4')
  id!: string;
}

@Controller('reminders')
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  /** 全部提醒、今日统计及注意事件。 */
  @Get()
  findAll() {
    return this.reminders.findAll();
  }

  /** 临期卡片使用药品 ID 和当前有效期定位。 */
  @Get('expiry/:medicineId')
  findExpiry(
    @Param('medicineId', idPipe) id: string,
    @Query() query: ExpiryDateQueryDto,
  ) {
    return this.reminders.findExpiry(id, query.expirationDate);
  }

  /** 标记处理、恢复待处理或忽略，不改药箱库存。 */
  @Patch('expiry/:medicineId')
  updateExpiry(
    @Param('medicineId', idPipe) id: string,
    @Body() dto: UpdateExpiryDto,
  ) {
    return this.reminders.updateExpiry(id, dto);
  }

  /** 查询提醒及当前执行日记录。 */
  @Get(':id')
  findOne(@Param('id', idPipe) id: string) {
    return this.reminders.findOne(id);
  }

  /** 创建提醒、快照及可选入箱记录。 */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateReminderDto) {
    return this.reminders.create(dto);
  }

  /** 编辑不改变类型，也不删除历史测量。 */
  @Patch(':id')
  update(@Param('id', idPipe) id: string, @Body() dto: UpdateReminderDto) {
    return this.reminders.update(id, dto);
  }

  /** 删除提醒并保留独立的血压数据。 */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', idPipe) id: string,
    @Query() query: ReminderVersionQueryDto,
  ): Promise<void> {
    await this.reminders.remove(id, query.expectedVersion);
  }

  /** 设置某次提醒的目标完成状态，禁止切换式重试。 */
  @Patch(':id/checkins/:occurrenceDate')
  updateCheckin(
    @Param('id', idPipe) id: string,
    @Param() params: CheckinParamsDto,
    @Body() dto: UpdateCheckinDto,
  ) {
    return this.reminders.updateCheckin(id, params.occurrenceDate, dto);
  }
}
