import { Module } from '@nestjs/common';
import { BloodPressureController } from './blood-pressure.controller.js';
import { RemindersController } from './reminders.controller.js';
import { RemindersService } from './reminders.service.js';

@Module({
  controllers: [RemindersController, BloodPressureController],
  providers: [RemindersService],
})
export class RemindersModule {}
