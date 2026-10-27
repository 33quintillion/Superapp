import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/zod';
import { Auth, AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/token.service';
import { SafetyService } from './safety.service';

const ReportBody = z.object({
  subjectType: z.enum(['user', 'message', 'post', 'comment', 'story', 'community', 'business', 'mini_app']),
  subjectId: z.string().min(1).max(100),
  reason: z.enum(['spam', 'harassment', 'hate', 'violence', 'sexual_content', 'child_safety', 'fraud', 'impersonation', 'other']),
  details: z.string().trim().max(2000).default(''),
});

@Controller('v1')
@UseGuards(AuthGuard)
export class SafetyController {
  constructor(private readonly safety: SafetyService) {}

  @Get('blocks')
  list(@Auth() a: AccessClaims) {
    return this.safety.listBlocks(a.userId);
  }

  @Post('blocks')
  @HttpCode(204)
  async block(@Auth() a: AccessClaims, @Body() body: unknown) {
    await this.safety.block(a.userId, parse(z.object({ userId: z.uuid() }), body).userId);
  }

  @Delete('blocks/:userId')
  @HttpCode(204)
  async unblock(@Auth() a: AccessClaims, @Param('userId') userId: string) {
    await this.safety.unblock(a.userId, parse(z.uuid(), userId));
  }

  @Post('reports')
  report(@Auth() a: AccessClaims, @Body() body: unknown) {
    return this.safety.report(a.userId, parse(ReportBody, body));
  }
}
