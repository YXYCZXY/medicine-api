import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  AiReadinessDto,
  AttachmentDto,
  SyncBatchDto,
  SyncQueryDto,
} from './sync.dto.js';
import { SyncService } from './sync.service.js';

@Controller('sync')
export class SyncController {
  constructor(private readonly service: SyncService) {}
  @Get('snapshot') snapshot(@Query() query: SyncQueryDto) {
    return this.service.snapshot(query.deviceId);
  }
  @Post('commands') commands(@Body() body: SyncBatchDto) {
    return this.service.commands(body.commands, body.attachmentFailures);
  }
  @Post('readiness') readiness(@Body() body: AiReadinessDto) {
    return this.service.readiness(
      body.deviceId,
      body.throughSequence,
      body.resolvedOpIds,
    );
  }
  @Post('attachments') attachment(@Body() body: AttachmentDto) {
    return this.service.uploadAttachment(body.id, body.base64);
  }
  @Get('attachments/:id') download(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.service.downloadAttachment(id);
  }
}
