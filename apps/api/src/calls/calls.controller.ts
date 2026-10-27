import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Auth, AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/token.service';
import { parse } from '../common/zod';
import { CallsService } from './calls.service';
import { IceService } from './ice.service';

const id = (v: string) => parse(z.uuid(), v);
const HistoryQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(200).optional() }).strict();
const HangupBody = z.object({ failed: z.boolean().default(false) }).strict();

/**
 * Starting, answering and signalling a call happen over the WebSocket, because they bind
 * the call to one connection (see docs/calls.md). These endpoints cover what doesn't
 * need a connection: history, TURN settings, and declining or hanging up (for example
 * from a notification action).
 */
@Controller('v1/calls')
@UseGuards(AuthGuard)
export class CallsController {
  constructor(
    private readonly calls: CallsService,
    private readonly ice: IceService,
  ) {}

  @Get()
  history(@Auth() a: AccessClaims, @Query() q: unknown) {
    return this.calls.history(a.userId, parse(HistoryQuery, q));
  }

  /** STUN/TURN settings for RTCPeerConnection, with short-lived TURN credentials. */
  @Get('ice-servers')
  iceServers(@Auth() a: AccessClaims) {
    return this.ice.forUser(a.userId);
  }

  @Get('active')
  active(@Auth() a: AccessClaims) {
    return this.calls.active(a.userId);
  }

  @Get(':id')
  get(@Auth() a: AccessClaims, @Param('id') callId: string) {
    return this.calls.get(a.userId, id(callId));
  }

  @Post(':id/decline')
  @HttpCode(200)
  decline(@Auth() a: AccessClaims, @Param('id') callId: string) {
    return this.calls.decline(a.userId, id(callId));
  }

  @Post(':id/hangup')
  @HttpCode(200)
  hangup(@Auth() a: AccessClaims, @Param('id') callId: string, @Body() body: unknown) {
    return this.calls.hangup(a.userId, id(callId), parse(HangupBody, body ?? {}).failed);
  }
}
