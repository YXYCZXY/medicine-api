import { Controller, Get, Query } from '@nestjs/common';
import { QueryBloodPressureDto } from './dto/checkin.dto.js';
import { RemindersService } from './reminders.service.js';

@Controller('blood-pressure-records')
export class BloodPressureController {
  constructor(private readonly reminders: RemindersService) {}

  /** 按业务日期查询当前用户测量，包含原提醒已删除的数据。 */
  @Get()
  findAll(@Query() query: QueryBloodPressureDto) {
    return this.reminders.findBloodPressure(query);
  }
}
