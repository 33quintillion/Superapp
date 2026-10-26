import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/zod';
import { Auth, AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/token.service';
import { isTimeZone, PushService } from './push.service';

const b64url = (min: number, max: number) => z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/, 'Must be base64url').min(min).max(max);

export const RegisterBody = z.discriminatedUnion('provider', [
  z
    .object({
      provider: z.literal('apns'),
      // APNs tokens are 32 bytes today, but Apple says not to rely on the length.
      token: z.string().regex(/^[0-9a-fA-F]{64,200}$/, 'Must be the hex device token'),
      environment: z.enum(['sandbox', 'production']),
    })
    .strict(),
  z
    .object({
      provider: z.literal('fcm'),
      token: z.string().regex(/^[A-Za-z0-9_:-]{20,4096}$/, 'Must be an FCM registration token').max(2048),
    })
    .strict(),
  z
    .object({
      provider: z.literal('webpush'),
      endpoint: z.string().max(2048),
      keys: z.object({ p256dh: b64url(80, 100), auth: b64url(16, 30) }).strict(),
    })
    .strict(),
]);

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');

export const SettingsBody = z
  .object({
    pushEnabled: z.boolean(),
    preview: z.enum(['full', 'sender', 'none']),
    quietHours: z
      .object({
        start: time,
        end: time,
        timeZone: z.string().max(64).refine(isTimeZone, 'Unknown time zone'),
      })
      .strict()
      .refine((q) => q.start !== q.end, { message: 'Start and end must differ', path: ['end'] })
      .nullable(),
  })
  .partial()
  .strict();

@Controller('v1')
@UseGuards(AuthGuard)
export class PushController {
  constructor(private readonly push: PushService) {}

  /** Which push services this server can deliver through, and the browser subscription key. */
  @Get('push/config')
  config() {
    return this.push.status();
  }

  @Get('push/devices')
  devices(@Auth() a: AccessClaims) {
    return this.push.list(a.userId, a.sessionId);
  }

  /** Registers this signed-in device for notifications (replaces any earlier token). */
  @Put('push/devices/current')
  register(@Auth() a: AccessClaims, @Body() body: unknown) {
    return this.push.registerCurrent(a.userId, a.sessionId, parse(RegisterBody, body));
  }

  @Delete('push/devices/current')
  @HttpCode(204)
  async unregister(@Auth() a: AccessClaims) {
    await this.push.removeCurrent(a.userId, a.sessionId);
  }

  @Post('push/devices/current/test')
  @HttpCode(202)
  test(@Auth() a: AccessClaims) {
    return this.push.sendTest(a.userId, a.sessionId);
  }

  @Delete('push/devices/:id')
  @HttpCode(204)
  async remove(@Auth() a: AccessClaims, @Param('id') id: string) {
    await this.push.remove(a.userId, parse(z.uuid(), id));
  }

  @Get('me/notifications')
  settings(@Auth() a: AccessClaims) {
    return this.push.settings(a.userId);
  }

  @Patch('me/notifications')
  update(@Auth() a: AccessClaims, @Body() body: unknown) {
    return this.push.updateSettings(a.userId, parse(SettingsBody, body));
  }
}
