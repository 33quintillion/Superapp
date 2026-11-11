import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/zod';
import { Auth, AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/token.service';
import { AiService } from './ai.service';

const id = (v: string) => parse(z.uuid(), v);
const TranslateBody = z.object({ to: z.string().min(2).max(10) }).strict();

@Controller('v1')
@UseGuards(AuthGuard)
export class AiController {
  constructor(private readonly ai: AiService) {}

  /** Whether translation and voice-to-text are on, and the languages offered. */
  @Get('ai/features')
  features() {
    return this.ai.features();
  }

  @Post('messages/:id/translate')
  @HttpCode(200)
  translate(@Auth() a: AccessClaims, @Param('id') mid: string, @Body() body: unknown) {
    return this.ai.translate(a.userId, id(mid), parse(TranslateBody, body).to);
  }

  @Post('messages/:id/transcribe')
  @HttpCode(200)
  transcribe(@Auth() a: AccessClaims, @Param('id') mid: string) {
    return this.ai.transcribe(a.userId, id(mid));
  }
}
