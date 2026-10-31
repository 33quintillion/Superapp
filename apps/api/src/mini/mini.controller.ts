import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/zod';
import { Auth, AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/token.service';
import { MiniListQuery, MiniProgramBody } from './mini.schemas';
import { MiniProgramsService } from './mini.service';

const id = (v: string) => parse(z.uuid(), v);

@Controller('v1')
@UseGuards(AuthGuard)
export class MiniProgramsController {
  constructor(private readonly mini: MiniProgramsService) {}

  @Get('mini-programs')
  list(@Query() q: unknown) {
    const { q: text, limit } = parse(MiniListQuery, q);
    return this.mini.list(text, limit);
  }

  @Get('me/mini-programs/recent')
  recents(@Auth() a: AccessClaims) {
    return this.mini.recents(a.userId);
  }

  @Get('mini-programs/:id')
  open(@Auth() a: AccessClaims, @Param('id') mid: string) {
    return this.mini.open(a.userId, id(mid));
  }

  /** For the business's staff. */
  @Get('businesses/:id/mini-program')
  async forBusiness(@Auth() a: AccessClaims, @Param('id') bid: string) {
    return { miniProgram: await this.mini.forBusiness(a.userId, id(bid)) };
  }

  @Put('businesses/:id/mini-program')
  save(@Auth() a: AccessClaims, @Param('id') bid: string, @Body() body: unknown) {
    return this.mini.saveDraft(a.userId, id(bid), parse(MiniProgramBody, body));
  }

  @Post('businesses/:id/mini-program/publish')
  @HttpCode(200)
  publish(@Auth() a: AccessClaims, @Param('id') bid: string) {
    return this.mini.publish(a.userId, id(bid));
  }

  @Delete('businesses/:id/mini-program/publish')
  unpublish(@Auth() a: AccessClaims, @Param('id') bid: string) {
    return this.mini.unpublish(a.userId, id(bid));
  }
}
