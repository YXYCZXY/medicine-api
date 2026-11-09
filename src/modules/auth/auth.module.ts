import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { UsersController } from './auth.controller.js';
import { ConfigService } from '@nestjs/config';
import { createProjectJwks, SUPABASE_JWKS, SupabaseIdentityService, SupabaseJwtVerifier } from './supabase-auth.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { UserContextMiddleware, UserContextService } from './user-context.service.js';
import { AccountDeletionController } from './account-deletion.controller.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { SupabaseAccountAdmin } from './supabase-account-admin.js';

@Global()
@Module({
  controllers: [UsersController, AccountDeletionController],
  providers: [AuthService, SupabaseIdentityService, SupabaseJwtVerifier, SupabaseAccountAdmin, AccountDeletionService, { provide: SUPABASE_JWKS, useFactory: createProjectJwks, inject: [ConfigService] }, AuthGuard, UserContextService, UserContextMiddleware, { provide: APP_GUARD, useExisting: AuthGuard }],
  exports: [UserContextService],
})
export class AuthModule {}
