import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './database/prisma/prisma.module.js';
import { MedicinesModule } from './modules/medicines/medicines.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    PrismaModule,

    MedicinesModule,
  ],
})
export class AppModule {}