import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parse, usernameSchema } from '../common/zod';
import { Auth, AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/token.service';
import { UsersService } from './users.service';

const ProfilePatch = z
  .object({
    displayName: z.string().trim().min(1).max(64),
    bio: z.string().trim().max(300),
    statusText: z.string().trim().max(140),
    locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'Use a BCP 47 tag like en or pt-BR'),
  })
  .partial()
  .strict();

const PrivacyPatch = z
  .object({
    discoverableByEmail: z.boolean(),
    discoverableByPhone: z.boolean(),
    discoverableByUsername: z.boolean(),
    whoCanMessage: z.enum(['everyone', 'contacts', 'nobody']),
    showOnlineStatus: z.boolean(),
    showReadReceipts: z.boolean(),
  })
  .partial()
  .strict();

const PasswordConfirm = z.object({ password: z.string().min(1).max(256) });

@Controller('v1')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@Auth() a: AccessClaims) {
    return this.users.me(a.userId);
  }

  @Patch('me')
  update(@Auth() a: AccessClaims, @Body() body: unknown) {
    return this.users.updateProfile(a.userId, parse(ProfilePatch, body));
  }

  @Get('me/privacy')
  privacy(@Auth() a: AccessClaims) {
    return this.users.privacy(a.userId);
  }

  @Patch('me/privacy')
  updatePrivacy(@Auth() a: AccessClaims, @Body() body: unknown) {
    return this.users.updatePrivacy(a.userId, parse(PrivacyPatch, body));
  }

  @Get('me/export')
  export(@Auth() a: AccessClaims) {
    return this.users.exportData(a.userId);
  }

  @Post('me/deactivate')
  @HttpCode(204)
  async deactivate(@Auth() a: AccessClaims, @Body() body: unknown) {
    await this.users.deactivate(a.userId, parse(PasswordConfirm, body).password);
  }

  @Delete('me')
  @HttpCode(204)
  async remove(@Auth() a: AccessClaims, @Body() body: unknown) {
    await this.users.deleteAccount(a.userId, parse(PasswordConfirm, body).password);
  }

  @Get('users/:username')
  profile(@Auth() a: AccessClaims, @Param('username') username: string) {
    return this.users.publicProfile(a.userId, parse(usernameSchema, username));
  }
}
