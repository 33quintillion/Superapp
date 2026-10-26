import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { parse } from '../common/zod';
import { Auth, AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/token.service';
import {
  ChangesQuery,
  ConversationsQuery,
  EditBody,
  ForwardBody,
  MembershipPatch,
  MessagesQuery,
  PinBody,
  PresenceQuery,
  ReactBody,
  ReceiptBody,
  SearchQuery,
  SendBody,
} from './messaging.schemas';
import { MessagingService } from './messaging.service';

const id = (v: string) => parse(z.uuid(), v);

@Controller('v1')
@UseGuards(AuthGuard)
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Get('conversations')
  list(@Auth() a: AccessClaims, @Query() q: unknown) {
    return this.messaging.listConversations(a.userId, parse(ConversationsQuery, q));
  }

  /** Opens (or returns) the direct chat with a user. */
  @Post('conversations/direct')
  @HttpCode(200)
  openDirect(@Auth() a: AccessClaims, @Body() body: unknown) {
    return this.messaging.openDirect(a.userId, parse(z.object({ userId: z.uuid() }).strict(), body).userId);
  }

  @Get('conversations/:id')
  get(@Auth() a: AccessClaims, @Param('id') cid: string) {
    return this.messaging.getConversation(a.userId, id(cid));
  }

  @Patch('conversations/:id')
  update(@Auth() a: AccessClaims, @Param('id') cid: string, @Body() body: unknown) {
    return this.messaging.updateMembership(a.userId, id(cid), parse(MembershipPatch, body));
  }

  @Get('conversations/:id/messages')
  messages(@Auth() a: AccessClaims, @Param('id') cid: string, @Query() q: unknown) {
    return this.messaging.listMessages(a.userId, id(cid), parse(MessagesQuery, q));
  }

  /** 201 for a new message, 200 when the clientId was already used (a retry). */
  @Post('conversations/:id/messages')
  async send(@Auth() a: AccessClaims, @Param('id') cid: string, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const r = await this.messaging.send(a.userId, id(cid), parse(SendBody, body));
    reply.status(r.duplicate ? 200 : 201);
    return r;
  }

  @Get('conversations/:id/changes')
  changes(@Auth() a: AccessClaims, @Param('id') cid: string, @Query() q: unknown) {
    const { since, limit } = parse(ChangesQuery, q);
    return this.messaging.changes(a.userId, id(cid), since, limit);
  }

  @Get('conversations/:id/pins')
  pins(@Auth() a: AccessClaims, @Param('id') cid: string) {
    return this.messaging.pinned(a.userId, id(cid));
  }

  @Post('conversations/:id/receipts')
  @HttpCode(200)
  receipt(@Auth() a: AccessClaims, @Param('id') cid: string, @Body() body: unknown) {
    const { kind, seq } = parse(ReceiptBody, body);
    return this.messaging.markReceipt(a.userId, id(cid), kind, seq);
  }

  @Patch('messages/:id')
  edit(@Auth() a: AccessClaims, @Param('id') mid: string, @Body() body: unknown) {
    return this.messaging.edit(a.userId, id(mid), parse(EditBody, body).body);
  }

  /** Delete for everyone (sender only). */
  @Delete('messages/:id')
  remove(@Auth() a: AccessClaims, @Param('id') mid: string) {
    return this.messaging.deleteForEveryone(a.userId, id(mid));
  }

  /** Delete for me. */
  @Post('messages/:id/hide')
  @HttpCode(204)
  async hide(@Auth() a: AccessClaims, @Param('id') mid: string) {
    await this.messaging.hideForMe(a.userId, id(mid));
  }

  @Put('messages/:id/reaction')
  react(@Auth() a: AccessClaims, @Param('id') mid: string, @Body() body: unknown) {
    return this.messaging.react(a.userId, id(mid), parse(ReactBody, body).emoji);
  }

  @Put('messages/:id/pin')
  pin(@Auth() a: AccessClaims, @Param('id') mid: string, @Body() body: unknown) {
    return this.messaging.pin(a.userId, id(mid), parse(PinBody, body).pinned);
  }

  @Post('messages/:id/forward')
  async forward(@Auth() a: AccessClaims, @Param('id') mid: string, @Body() body: unknown) {
    const { conversationIds, clientId } = parse(ForwardBody, body);
    return { messages: await this.messaging.forward(a.userId, id(mid), conversationIds, clientId) };
  }

  @Get('messages/search')
  search(@Auth() a: AccessClaims, @Query() q: unknown) {
    const { q: text, ...opts } = parse(SearchQuery, q);
    return this.messaging.search(a.userId, text, opts);
  }

  @Get('presence')
  presence(@Auth() a: AccessClaims, @Query() q: unknown) {
    return this.messaging.presenceFor(a.userId, parse(PresenceQuery, q).userIds);
  }
}
