import { Module } from '@nestjs/common';
import { MedicinesService } from './medicines.service.js';
import { MedicinesController } from './medicines.controller.js';

@Module({
  providers: [MedicinesService],
  controllers: [MedicinesController]
})
export class MedicinesModule {}
