import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController, UsersController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { UserContextMiddleware, UserContextService } from './user-context.service.js';

@Global()
@Module({
  controllers: [AuthController, UsersController],
  providers: [AuthService, AuthGuard, UserContextService, UserContextMiddleware, { provide: APP_GUARD, useExisting: AuthGuard }],
  exports: [UserContextService],
})
export class AuthModule {}
