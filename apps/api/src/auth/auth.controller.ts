import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { emailSchema, parse, passwordSchema, usernameSchema } from '../common/zod';
import { Auth, AuthGuard, Client, ClientInfo } from './auth.guard';
import { AuthService } from './auth.service';
import type { AccessClaims } from './token.service';

const deviceName = z.string().trim().max(100).optional();
const token = z.string().min(20).max(200);
const totpCode = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

const RegisterBody = z.object({
  email: emailSchema,
  password: passwordSchema,
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(64),
  deviceName,
});
const LoginBody = z.object({ email: emailSchema, password: z.string().min(1).max(256), deviceName });
const MfaLoginBody = z.object({ mfaToken: token, code: totpCode, deviceName });
/** A Firebase ID token: three base64url parts, about 1 kB. */
const idToken = z.string().min(100).max(4096).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'Not an ID token');
const PhoneBody = z.object({ idToken, deviceName });
const PhoneCompleteBody = z.object({ signupToken: token, displayName: z.string().trim().min(1).max(64), username: usernameSchema.optional(), deviceName });
/** Password for accounts that have one; a fresh phone code otherwise. */
export const IdentityProofBody = z.object({ password: z.string().min(1).max(256).optional(), phoneIdToken: idToken.optional() });

@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() body: unknown, @Client() client: ClientInfo) {
    return this.auth.register(parse(RegisterBody, body), client);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown, @Client() client: ClientInfo) {
    return this.auth.login(parse(LoginBody, body), client);
  }

  @Post('phone')
  @HttpCode(200)
  phone(@Body() body: unknown, @Client() client: ClientInfo) {
    return this.auth.phoneSignIn(parse(PhoneBody, body), client);
  }

  @Post('phone/complete')
  phoneComplete(@Body() body: unknown, @Client() client: ClientInfo) {
    return this.auth.phoneSignUp(parse(PhoneCompleteBody, body), client);
  }

  @Post('login/mfa')
  @HttpCode(200)
  loginMfa(@Body() body: unknown, @Client() client: ClientInfo) {
    return this.auth.loginWithMfa(parse(MfaLoginBody, body), client);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: unknown, @Client() client: ClientInfo) {
    return this.auth.refresh(parse(z.object({ refreshToken: token }), body).refreshToken, client);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async logout(@Auth() a: AccessClaims) {
    await this.auth.logout(a.sessionId, a.userId);
  }

  @Post('verify-email')
  @HttpCode(200)
  verifyEmail(@Body() body: unknown) {
    return this.auth.verifyEmail(parse(z.object({ token }), body).token);
  }

  @Post('verify-email/resend')
  @HttpCode(202)
  @UseGuards(AuthGuard)
  async resend(@Auth() a: AccessClaims) {
    await this.auth.resendVerification(a.userId);
  }

  @Post('password/forgot')
  @HttpCode(202)
  async forgot(@Body() body: unknown, @Client() client: ClientInfo) {
    await this.auth.forgotPassword(parse(z.object({ email: emailSchema }), body).email, client);
  }

  @Post('password/reset')
  @HttpCode(204)
  async reset(@Body() body: unknown, @Client() client: ClientInfo) {
    const b = parse(z.object({ token, newPassword: passwordSchema }), body);
    await this.auth.resetPassword(b.token, b.newPassword, client);
  }

  @Post('password/change')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async change(@Auth() a: AccessClaims, @Body() body: unknown) {
    const b = parse(z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema }), body);
    await this.auth.changePassword(a.userId, a.sessionId, b.currentPassword, b.newPassword);
  }

  @Post('mfa/setup')
  @UseGuards(AuthGuard)
  mfaSetup(@Auth() a: AccessClaims) {
    return this.auth.beginMfaSetup(a.userId);
  }

  @Post('mfa/confirm')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async mfaConfirm(@Auth() a: AccessClaims, @Body() body: unknown) {
    await this.auth.confirmMfaSetup(a.userId, parse(z.object({ code: totpCode }), body).code);
  }

  @Post('mfa/disable')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async mfaDisable(@Auth() a: AccessClaims, @Body() body: unknown) {
    const b = parse(IdentityProofBody.extend({ code: totpCode }), body);
    await this.auth.disableMfa(a.userId, b, b.code);
  }
}

/** The optional email address, for receipts, banking and payouts. Phone accounts don't sign in with it. */
@Controller('v1/me/email')
@UseGuards(AuthGuard)
export class EmailController {
  constructor(private readonly auth: AuthService) {}

  @Put()
  set(@Auth() a: AccessClaims, @Body() body: unknown) {
    return this.auth.setEmail(a.userId, parse(z.object({ email: emailSchema }), body).email);
  }

  @Delete()
  @HttpCode(204)
  async remove(@Auth() a: AccessClaims) {
    await this.auth.removeEmail(a.userId);
  }
}

@Controller('v1/sessions')
@UseGuards(AuthGuard)
export class SessionsController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  list(@Auth() a: AccessClaims) {
    return this.auth.listSessions(a.userId, a.sessionId);
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@Auth() a: AccessClaims, @Param('id') id: string) {
    await this.auth.revokeSession(a.userId, parse(z.uuid(), id), 'user_revoked');
  }
}
