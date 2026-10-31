import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { emailSchema, parse, usernameSchema } from '../common/zod';
import { IdentityProofBody } from '../auth/auth.controller';
import { Auth, AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/token.service';
import { CONTACTS_MAX, UsersService } from './users.service';

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
    privateAccount: z.boolean(),
    whoCanAddToGroups: z.enum(['everyone', 'following', 'nobody']),
  })
  .partial()
  .strict();

const AvatarPut = z.object({ mediaId: z.string().uuid() }).strict();

/**
 * Entries that aren't a valid email address or an E.164 phone number (after removing spaces,
 * dashes, dots and brackets) are skipped rather than refused: address books are messy.
 */
const phoneEntry = z.string().max(40).transform((p) => p.replace(/[\s\-().]/g, ''));
const ContactsMatch = z
  .object({ emails: z.array(z.string().max(254)).max(CONTACTS_MAX).default([]), phones: z.array(phoneEntry).max(CONTACTS_MAX).default([]) })
  .strict()
  .refine((b) => b.emails.length + b.phones.length <= CONTACTS_MAX, `At most ${CONTACTS_MAX} entries at a time`)
  .transform((b) => ({
    emails: b.emails.flatMap((e) => {
      const r = emailSchema.safeParse(e);
      return r.success ? [r.data] : [];
    }),
    phones: b.phones.filter((p) => /^\+[1-9][0-9]{6,14}$/.test(p)),
  }));



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

  @Put('me/avatar')
  setAvatar(@Auth() a: AccessClaims, @Body() body: unknown) {
    return this.users.setAvatar(a.userId, parse(AvatarPut, body).mediaId);
  }

  @Delete('me/avatar')
  removeAvatar(@Auth() a: AccessClaims) {
    return this.users.setAvatar(a.userId, null);
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
    await this.users.deactivate(a.userId, parse(IdentityProofBody, body));
  }

  @Delete('me')
  @HttpCode(204)
  async remove(@Auth() a: AccessClaims, @Body() body: unknown) {
    await this.users.deleteAccount(a.userId, parse(IdentityProofBody, body));
  }

  @Post('contacts/match')
  @HttpCode(200)
  matchContacts(@Auth() a: AccessClaims, @Body() body: unknown) {
    return this.users.matchContacts(a.userId, parse(ContactsMatch, body));
  }

  @Get('users/:username')
  profile(@Auth() a: AccessClaims, @Param('username') username: string) {
    return this.users.publicProfile(a.userId, parse(usernameSchema, username));
  }
}
