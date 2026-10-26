import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/zod';
import { Auth, AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/token.service';
import { MediaService } from './media.service';

const UploadBody = z
  .object({
    kind: z.enum(['image', 'video', 'audio', 'voice', 'file']),
    contentType: z.string().trim().toLowerCase().max(127),
    byteSize: z.number().int().positive(),
    fileName: z
      .string()
      .trim()
      .max(255)
      .transform((n) => n.replace(/[\\/\u0000-\u001f]/g, '_'))
      .default(''),
    durationMs: z.number().int().positive().max(24 * 3600 * 1000).optional(),
    width: z.number().int().positive().max(20000).optional(),
    height: z.number().int().positive().max(20000).optional(),
  })
  .strict();

@Controller('v1/media')
@UseGuards(AuthGuard)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('uploads')
  create(@Auth() a: AccessClaims, @Body() body: unknown) {
    return this.media.createUpload(a.userId, parse(UploadBody, body));
  }

  @Post(':id/complete')
  @HttpCode(200)
  complete(@Auth() a: AccessClaims, @Param('id') id: string) {
    return this.media.complete(a.userId, parse(z.uuid(), id));
  }

  @Get(':id')
  download(@Auth() a: AccessClaims, @Param('id') id: string) {
    return this.media.download(a.userId, parse(z.uuid(), id));
  }
}
