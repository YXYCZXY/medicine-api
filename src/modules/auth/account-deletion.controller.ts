import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { AccountDeletionService } from './account-deletion.service.js';
import { DeleteAccountDto } from './account-deletion.dto.js';
import { Public } from './public.decorator.js';
import { SupabaseAccountAdmin } from './supabase-account-admin.js';
import { SupabaseJwtVerifier } from './supabase-auth.js';
import { PrismaService } from '../../database/prisma/prisma.service.js';
import { lockUserWrites } from '../user-dictionaries/dictionary-actions.js';

const bearer = (header?: string) =>
  /^Bearer (\S+)$/i.exec(header ?? '')?.[1] ?? '';
@Controller()
export class AccountDeletionController {
  constructor(
    private readonly deletion: AccountDeletionService,
    private readonly admin: SupabaseAccountAdmin,
    private readonly verifier: SupabaseJwtVerifier,
    private readonly prisma: PrismaService,
  ) {}
  @Post('users/me/deletion-code')
  @HttpCode(200)
  sendCode() {
    return this.deletion.sendCode();
  }
  @Delete('users/me')
  @HttpCode(202)
  remove(@Body() dto: DeleteAccountDto) {
    return this.deletion.submit(dto);
  }
  @Public()
  @Get('account-deletions/:id')
  status(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.deletion.status(id, bearer(authorization));
  }
  @Public()
  @Post('account-deletions/:id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.deletion.cancelUnaccepted(id, bearer(authorization));
  }
  @Public()
  @Get('users/me/deletion-status')
  async accountStatus(@Headers('authorization') authorization?: string) {
    // A historically signed token can ONLY check deletion, never access business data.
    // This allows another device with an expired session to safely purge a deleted account.
    const userId = await this.verifier.verifyDeletionStatusToken(
      bearer(authorization),
    );
    return this.prisma.$transaction(
      async (tx) => {
        await lockUserWrites(tx, userId);
        const user = await tx.users.findUnique({
          where: { id: userId },
          select: { status: true },
        });
        if (user?.status === 'deleting') return { status: 'deleting' as const };
        const exists = await this.admin.exists(userId);
        return { status: exists ? ('active' as const) : ('deleted' as const) };
      },
      { timeout: 15_000 },
    );
  }
}
