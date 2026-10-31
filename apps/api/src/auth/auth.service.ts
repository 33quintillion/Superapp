import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { APP_CONFIG, AppConfig } from '../config/config';
import { AuditService } from '../common/audit.service';
import { AppError, Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { SecretBox } from '../crypto/secret-box';
import { hashToken, randomToken } from '../crypto/tokens';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../crypto/totp';
import { DatabaseService, Queryable } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import { RedisService } from '../redis/redis.service';
import type { ClientInfo } from './auth.guard';
import { BreachedPasswordsService } from './breached-passwords.service';
import { hashPassword, verifyPassword } from './password';
import { PhoneTokenService } from './phone-token.service';
import { TokenService } from './token.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
}

export type LoginResult = TokenPair | { mfaRequired: true; mfaToken: string };

/** A verified number with no account yet: the app asks for a name, then calls phone/complete. */
export type PhoneSignInResult = LoginResult | { signupRequired: true; signupToken: string; phone: string };

/** What proves it's really the account holder before something drastic (delete, turn off two-step). */
export interface IdentityProof {
  password?: string;
  /** A fresh Firebase ID token for the account's own number, for accounts without a password. */
  phoneIdToken?: string;
}

const RULES = {
  registerIp: { name: 'register:ip', limit: 10, windowSeconds: 3600 },
  loginIp: { name: 'login:ip', limit: 30, windowSeconds: 900 },
  loginAccount: { name: 'login:acct', limit: 10, windowSeconds: 900 },
  mfaToken: { name: 'mfa:token', limit: 5, windowSeconds: 300 },
  forgotIp: { name: 'forgot:ip', limit: 10, windowSeconds: 3600 },
  forgotAccount: { name: 'forgot:acct', limit: 3, windowSeconds: 3600 },
  resendVerify: { name: 'verify:resend', limit: 3, windowSeconds: 3600 },
  phoneIp: { name: 'phone:ip', limit: 30, windowSeconds: 900 },
  emailSet: { name: 'email:set', limit: 5, windowSeconds: 3600 },
  refreshIp: { name: 'refresh:ip', limit: 120, windowSeconds: 900 },
  // Per account, across every challenge token, so asking for new tokens doesn't buy more guesses.
  totpAccount: { name: 'totp:acct', limit: 10, windowSeconds: 900 },
};

/**
 * Re-entering the password inside a signed-in session (change password, turn off two-step,
 * deactivate, delete). Without a limit, someone holding a stolen session could guess the
 * password and then lock the owner out.
 */
export const PASSWORD_CONFIRM_RULE = { name: 'password:confirm', limit: 10, windowSeconds: 900 };

const VERIFY_TTL_H = 48;
const RESET_TTL_MIN = 30;
const MFA_CHALLENGE_TTL_MIN = 5;
const PHONE_SIGNUP_TTL_S = 15 * 60;

@Injectable()
export class AuthService {
  private readonly box: SecretBox;

  constructor(
    private readonly db: DatabaseService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
    private readonly breached: BreachedPasswordsService,
    private readonly phone: PhoneTokenService,
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.box = new SecretBox(config.DATA_ENCRYPTION_KEY);
  }

  async register(
    input: { email: string; password: string; username: string; displayName: string; deviceName?: string },
    client: ClientInfo,
  ): Promise<TokenPair> {
    if (!this.config.EMAIL_SIGNUP) {
      throw new AppError(HttpStatus.FORBIDDEN, 'email_signup_closed', 'Sign up with your phone number instead');
    }
    await this.limits.consume(RULES.registerIp, client.ip ?? 'unknown');
    await this.breached.assertNotBreached(input.password);
    const passwordHash = await hashPassword(input.password);
    const { userId, pair } = await this.db.tx(async (tx) => {
      const taken = await this.db.one<{ email: string | null; username: string | null }>(
        'SELECT email, username FROM users WHERE email = $1 OR username = $2 LIMIT 1',
        [input.email, input.username],
        tx,
      );
      if (taken?.username === input.username) throw Errors.conflict('username_taken', 'That username is taken');
      if (taken) throw Errors.conflict('email_taken', 'An account with that email already exists');
      const user = await this.db.one<{ id: string }>(
        `INSERT INTO users (email, username, password_hash, display_name) VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.email, input.username, passwordHash, input.displayName],
        tx,
      );
      const userId = user!.id;
      await this.db.query('INSERT INTO privacy_settings (user_id) VALUES ($1)', [userId], tx);
      await this.audit.record({ actorId: userId, action: 'auth.register', ip: client.ip }, tx);
      const pair = await this.createSession(tx, userId, input.deviceName, client);
      return { userId, pair };
    }).catch((err) => {
      // Two concurrent sign-ups with the same email/username: the unique index decides.
      if ((err as { code?: string }).code === '23505') {
        throw Errors.conflict('account_exists', 'That email or username is already in use');
      }
      throw err;
    });
    await this.sendVerification(userId, input.email);
    return pair;
  }

  // --- Phone sign-in (Firebase codes) ---

  /**
   * Signs in with a verified phone number. An existing account gets a session (or the two-step
   * challenge); a new number gets a short-lived sign-up token so the app can ask for a name.
   */
  async phoneSignIn(input: { idToken: string; deviceName?: string }, client: ClientInfo): Promise<PhoneSignInResult> {
    await this.limits.consume(RULES.phoneIp, client.ip ?? 'unknown');
    const phone = await this.phone.verify(input.idToken);
    const user = await this.db.one<{ id: string; state: string; mfa_enabled_at: Date | null }>(
      `SELECT id, state, mfa_enabled_at FROM users WHERE phone_e164 = $1 AND state <> 'deleted'`,
      [phone],
    );
    if (!user) {
      const signupToken = randomToken();
      await this.redis.client.set(`phone-signup:${hashToken(signupToken)}`, phone, 'EX', PHONE_SIGNUP_TTL_S);
      return { signupRequired: true, signupToken, phone };
    }
    if (user.state === 'suspended') throw Errors.accountSuspended();
    await this.db.query('UPDATE users SET phone_verified_at = now(), updated_at = now() WHERE id = $1', [user.id]);
    if (user.mfa_enabled_at) {
      const mfaToken = await this.issueOneTimeToken(user.id, 'mfa_challenge', `${MFA_CHALLENGE_TTL_MIN} minutes`);
      return { mfaRequired: true, mfaToken };
    }
    return this.completeLogin(user.id, user.state, input.deviceName, client);
  }

  /** Creates the account for a number verified by phoneSignIn. Usernames are optional. */
  async phoneSignUp(input: { signupToken: string; displayName: string; username?: string; deviceName?: string }, client: ClientInfo): Promise<TokenPair> {
    await this.limits.consume(RULES.registerIp, client.ip ?? 'unknown');
    const key = `phone-signup:${hashToken(input.signupToken)}`;
    const phone = await this.redis.client.get(key);
    if (!phone) throw Errors.invalidToken();
    const pair = await this.db
      .tx(async (tx) => {
        const taken = await this.db.one<{ phone_e164: string | null; username: string | null }>(
          `SELECT phone_e164, username FROM users WHERE phone_e164 = $1 OR ($2::text IS NOT NULL AND username = $2) LIMIT 1`,
          [phone, input.username ?? null],
          tx,
        );
        if (taken?.phone_e164 === phone) throw Errors.conflict('phone_taken', 'This number already has an account. Sign in instead.');
        if (taken) throw Errors.conflict('username_taken', 'That username is taken');
        const user = await this.db.one<{ id: string }>(
          `INSERT INTO users (phone_e164, phone_verified_at, username, display_name) VALUES ($1, now(), $2, $3) RETURNING id`,
          [phone, input.username ?? null, input.displayName],
          tx,
        );
        const userId = user!.id;
        await this.db.query('INSERT INTO privacy_settings (user_id) VALUES ($1)', [userId], tx);
        await this.audit.record({ actorId: userId, action: 'auth.register', ip: client.ip, metadata: { method: 'phone' } }, tx);
        return this.createSession(tx, userId, input.deviceName, client);
      })
      .catch((err) => {
        if ((err as { code?: string }).code === '23505') throw Errors.conflict('account_exists', 'That number or username is already in use');
        throw err;
      });
    await this.redis.client.del(key);
    return pair;
  }

  /**
   * Confirms it's the account holder: their password, or for accounts without one, a fresh
   * code sent to their own number. Limited per account so a stolen session can't guess.
   */
  async confirmIdentity(userId: string, proof: IdentityProof) {
    await this.limits.consume(PASSWORD_CONFIRM_RULE, userId);
    const u = await this.db.one<{ password_hash: string | null; phone_e164: string | null }>('SELECT password_hash, phone_e164 FROM users WHERE id = $1', [userId]);
    if (u?.password_hash) {
      if (!(await verifyPassword(u.password_hash, proof.password ?? ''))) throw Errors.invalidCredentials();
      return;
    }
    if (!u?.phone_e164 || !proof.phoneIdToken) throw new AppError(HttpStatus.UNAUTHORIZED, 'phone_confirmation_required', 'Confirm with a code sent to your phone');
    if ((await this.phone.verify(proof.phoneIdToken)) !== u.phone_e164) throw Errors.invalidToken();
  }

  // --- Optional email (for receipts, banking and payouts) ---

  /** Adds or changes the account's email and sends a confirmation link. Not a way to sign in for phone accounts. */
  async setEmail(userId: string, email: string) {
    await this.limits.consume(RULES.emailSet, userId);
    const u = await this.db.one<{ email: string | null; email_verified_at: Date | null; password_hash: string | null }>(
      'SELECT email, email_verified_at, password_hash FROM users WHERE id = $1',
      [userId],
    );
    if (u?.email === email) {
      if (!u.email_verified_at) await this.sendVerification(userId, email);
      return { email, verified: Boolean(u.email_verified_at) };
    }
    await this.db
      .tx(async (tx) => {
        await this.db.query('UPDATE users SET email = $2, email_verified_at = NULL, updated_at = now() WHERE id = $1', [userId, email], tx);
        // Links sent to the old address must not confirm the new one.
        await this.db.query(`UPDATE one_time_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'verify_email' AND used_at IS NULL`, [userId], tx);
        await this.audit.record({ actorId: userId, action: 'account.email_changed' }, tx);
      })
      .catch((err) => {
        if ((err as { code?: string }).code === '23505') throw Errors.conflict('email_taken', 'That email is used by another account');
        throw err;
      });
    await this.sendVerification(userId, email);
    return { email, verified: false };
  }

  async removeEmail(userId: string) {
    const u = await this.db.one<{ email: string | null; phone_e164: string | null }>('SELECT email, phone_e164 FROM users WHERE id = $1', [userId]);
    if (!u?.email) return;
    if (!u.phone_e164) throw Errors.conflict('email_is_login', 'This email is how you sign in, so it cannot be removed');
    await this.db.tx(async (tx) => {
      await this.db.query('UPDATE users SET email = NULL, email_verified_at = NULL, updated_at = now() WHERE id = $1', [userId], tx);
      await this.db.query(`UPDATE one_time_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'verify_email' AND used_at IS NULL`, [userId], tx);
      await this.audit.record({ actorId: userId, action: 'account.email_removed' }, tx);
    });
  }

  async resendVerification(userId: string) {
    await this.limits.consume(RULES.resendVerify, userId);
    const u = await this.db.one<{ email: string; email_verified_at: Date | null }>(
      'SELECT email, email_verified_at FROM users WHERE id = $1',
      [userId],
    );
    if (!u?.email || u.email_verified_at) return;
    await this.sendVerification(userId, u.email);
  }

  async sendVerification(userId: string, email: string) {
    const token = await this.issueOneTimeToken(userId, 'verify_email', `${VERIFY_TTL_H} hours`);
    await this.mail.send({
      to: email,
      subject: 'Confirm your email',
      text: `Confirm your email address by opening this link within ${VERIFY_TTL_H} hours:\n\n${this.config.PUBLIC_WEB_URL}/verify-email?token=${token}\n\nIf you did not create an account, ignore this email.`,
    });
  }

  async verifyEmail(token: string) {
    const userId = await this.db.tx(async (tx) => {
      const id = await this.consumeOneTimeToken(tx, token, 'verify_email');
      await this.db.query('UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1 AND email_verified_at IS NULL', [id], tx);
      await this.audit.record({ actorId: id, action: 'auth.email_verified' }, tx);
      return id;
    });
    return { userId };
  }

  async login(input: { email: string; password: string; deviceName?: string }, client: ClientInfo): Promise<LoginResult> {
    await this.limits.consume(RULES.loginIp, client.ip ?? 'unknown');
    await this.limits.consume(RULES.loginAccount, input.email);
    const user = await this.db.one<{ id: string; password_hash: string | null; state: string; mfa_enabled_at: Date | null }>(
      `SELECT id, password_hash, state, mfa_enabled_at FROM users WHERE email = $1 AND state <> 'deleted'`,
      [input.email],
    );
    const ok = await verifyPassword(user?.password_hash ?? null, input.password);
    if (!user || !ok) {
      if (user) await this.audit.record({ actorId: user.id, action: 'auth.login_failed', ip: client.ip });
      throw Errors.invalidCredentials();
    }
    // Only after the password checks out, so this can't be used to find suspended accounts.
    if (user.state === 'suspended') throw Errors.accountSuspended();
    if (user.mfa_enabled_at) {
      const mfaToken = await this.issueOneTimeToken(user.id, 'mfa_challenge', `${MFA_CHALLENGE_TTL_MIN} minutes`);
      return { mfaRequired: true, mfaToken };
    }
    return this.completeLogin(user.id, user.state, input.deviceName, client);
  }

  async loginWithMfa(input: { mfaToken: string; code: string; deviceName?: string }, client: ClientInfo): Promise<TokenPair> {
    await this.limits.consume(RULES.mfaToken, hashToken(input.mfaToken));
    const row = await this.db.one<{ user_id: string }>(
      `SELECT user_id FROM one_time_tokens WHERE token_hash = $1 AND purpose = 'mfa_challenge' AND used_at IS NULL AND expires_at > now()`,
      [hashToken(input.mfaToken)],
    );
    if (!row) throw Errors.invalidToken();
    const userId = row.user_id;
    const user = await this.db.one<{ state: string }>('SELECT state FROM users WHERE id = $1', [userId]);
    if (user!.state === 'suspended') throw Errors.accountSuspended();
    await this.checkTotp(userId, input.code);
    const used = await this.db.query(`UPDATE one_time_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL`, [hashToken(input.mfaToken)]);
    if (used.rowCount === 0) throw Errors.invalidToken();
    return this.completeLogin(userId, user!.state, input.deviceName, client, true);
  }

  private async completeLogin(userId: string, state: string, deviceName: string | undefined, client: ClientInfo, mfa = false) {
    return this.db.tx(async (tx) => {
      if (state === 'deactivated') {
        // Deactivation is reversible by signing in again (see docs/feature-checklist.md).
        await this.db.query(`UPDATE users SET state = 'active', updated_at = now() WHERE id = $1`, [userId], tx);
        await this.audit.record({ actorId: userId, action: 'account.reactivated', ip: client.ip }, tx);
      }
      await this.audit.record({ actorId: userId, action: 'auth.login', ip: client.ip }, tx);
      return this.createSession(tx, userId, deviceName, client, mfa);
    });
  }

  async refresh(refreshToken: string, client: ClientInfo): Promise<TokenPair> {
    await this.limits.consume(RULES.refreshIp, client.ip ?? 'unknown');
    const presented = hashToken(refreshToken);
    const outcome = await this.db.tx(async (tx) => {
      const s = await this.db.one<{ id: string; user_id: string; revoked_at: Date | null; expires_at: Date }>(
        `SELECT s.id, s.user_id, s.revoked_at, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.refresh_token_hash = $1 AND u.state = 'active' FOR UPDATE OF s`,
        [presented],
        tx,
      );
      if (!s) {
        const retired = await this.db.one<{ session_id: string }>('SELECT session_id FROM retired_refresh_tokens WHERE token_hash = $1', [presented], tx);
        if (retired) {
          // A rotated-out token came back: assume theft and kill the whole session.
          await this.db.query(
            `UPDATE sessions SET revoked_at = now(), revoked_reason = 'refresh_reuse' WHERE id = $1 AND revoked_at IS NULL`,
            [retired.session_id],
            tx,
          );
          await this.audit.record({ actorId: null, action: 'auth.refresh_reuse_detected', targetType: 'session', targetId: retired.session_id, ip: client.ip }, tx);
          return { reuse: true as const };
        }
        return null;
      }
      if (s.revoked_at || s.expires_at < new Date()) return null;
      const next = randomToken();
      await this.db.query('INSERT INTO retired_refresh_tokens (token_hash, session_id) VALUES ($1, $2)', [presented, s.id], tx);
      await this.db.query(
        `UPDATE sessions SET refresh_token_hash = $2, refresh_generation = refresh_generation + 1, last_used_at = now(), ip = COALESCE($3, ip) WHERE id = $1`,
        [s.id, hashToken(next), client.ip],
        tx,
      );
      return { pair: await this.pairFor(s.user_id, s.id, next) };
    });
    // Commit the revocation before failing, so reuse detection is not rolled back.
    if (!outcome || 'reuse' in outcome) throw Errors.unauthorized('Refresh token is invalid');
    return outcome.pair;
  }

  async logout(sessionId: string, actorId: string) {
    await this.revokeSession(actorId, sessionId, 'logout');
  }

  async revokeSession(userId: string, sessionId: string, reason: string) {
    const res = await this.db.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [sessionId, userId, reason],
    );
    if (res.rowCount === 0) throw Errors.notFound('Session');
    await this.audit.record({ actorId: userId, action: 'auth.session_revoked', targetType: 'session', targetId: sessionId, metadata: { reason } });
  }

  async listSessions(userId: string, currentSessionId: string) {
    const { rows } = await this.db.query<{ id: string; device_name: string; user_agent: string | null; ip: string | null; created_at: Date; last_used_at: Date }>(
      `SELECT id, device_name, user_agent, host(ip) AS ip, created_at, last_used_at FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_used_at DESC`,
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      deviceName: r.device_name,
      userAgent: r.user_agent,
      ip: r.ip,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      current: r.id === currentSessionId,
    }));
  }

  async forgotPassword(email: string, client: ClientInfo) {
    await this.limits.consume(RULES.forgotIp, client.ip ?? 'unknown');
    await this.limits.consume(RULES.forgotAccount, email);
    const user = await this.db.one<{ id: string }>(`SELECT id FROM users WHERE email = $1 AND state <> 'deleted'`, [email]);
    // Same response either way so this endpoint cannot be used to discover accounts.
    if (!user) return;
    const token = await this.issueOneTimeToken(user.id, 'reset_password', `${RESET_TTL_MIN} minutes`);
    await this.mail.send({
      to: email,
      subject: 'Reset your password',
      text: `Someone asked to reset the password for this account. If it was you, open this link within ${RESET_TTL_MIN} minutes:\n\n${this.config.PUBLIC_WEB_URL}/reset-password?token=${token}\n\nIf it was not you, you can ignore this email; your password has not changed.`,
    });
    await this.audit.record({ actorId: user.id, action: 'auth.password_reset_requested', ip: client.ip });
  }

  async resetPassword(token: string, newPassword: string, client: ClientInfo) {
    await this.breached.assertNotBreached(newPassword);
    const passwordHash = await hashPassword(newPassword);
    await this.db.tx(async (tx) => {
      const userId = await this.consumeOneTimeToken(tx, token, 'reset_password');
      await this.db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [userId, passwordHash], tx);
      await this.db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_reset' WHERE user_id = $1 AND revoked_at IS NULL`, [userId], tx);
      // A reset link proves control of the email address, so also invalidate any other outstanding reset links.
      await this.db.query(`UPDATE one_time_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'reset_password' AND used_at IS NULL`, [userId], tx);
      await this.audit.record({ actorId: userId, action: 'auth.password_reset', ip: client.ip }, tx);
    });
  }

  async changePassword(userId: string, currentSessionId: string, current: string, next: string) {
    await this.limits.consume(PASSWORD_CONFIRM_RULE, userId);
    const u = await this.db.one<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (!(await verifyPassword(u?.password_hash ?? null, current))) throw Errors.invalidCredentials();
    await this.breached.assertNotBreached(next);
    const passwordHash = await hashPassword(next);
    await this.db.tx(async (tx) => {
      await this.db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [userId, passwordHash], tx);
      await this.db.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_changed' WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [userId, currentSessionId],
        tx,
      );
      await this.audit.record({ actorId: userId, action: 'auth.password_changed' }, tx);
    });
  }

  // --- MFA (TOTP) ---

  async beginMfaSetup(userId: string) {
    const u = await this.db.one<{ email: string | null; phone_e164: string | null; username: string | null; mfa_enabled_at: Date | null }>(
      'SELECT email, phone_e164, username, mfa_enabled_at FROM users WHERE id = $1',
      [userId],
    );
    if (u!.mfa_enabled_at) throw Errors.conflict('mfa_already_enabled', 'Two-step verification is already on');
    const secret = generateTotpSecret();
    await this.db.query('UPDATE users SET mfa_pending_secret_enc = $2 WHERE id = $1', [userId, this.box.seal(secret, userId)]);
    return { secret, otpauthUri: otpauthUri(secret, u!.email ?? u!.phone_e164 ?? u!.username ?? 'account', 'Nexa') };
  }

  async confirmMfaSetup(userId: string, code: string) {
    const u = await this.db.one<{ mfa_pending_secret_enc: string | null }>('SELECT mfa_pending_secret_enc FROM users WHERE id = $1', [userId]);
    if (!u?.mfa_pending_secret_enc) throw Errors.conflict('mfa_not_started', 'Start two-step setup first');
    const secret = this.box.open(u.mfa_pending_secret_enc, userId);
    const counter = verifyTotp(secret, code);
    if (counter === null) throw Errors.invalidToken();
    await this.db.query(
      `UPDATE users SET mfa_totp_secret_enc = mfa_pending_secret_enc, mfa_pending_secret_enc = NULL, mfa_enabled_at = now(), mfa_last_counter = $2 WHERE id = $1`,
      [userId, counter],
    );
    await this.audit.record({ actorId: userId, action: 'auth.mfa_enabled' });
  }

  async disableMfa(userId: string, proof: IdentityProof, code: string) {
    const u = await this.db.one<{ mfa_enabled_at: Date | null }>('SELECT mfa_enabled_at FROM users WHERE id = $1', [userId]);
    if (!u?.mfa_enabled_at) throw Errors.conflict('mfa_not_enabled', 'Two-step verification is not on');
    await this.confirmIdentity(userId, proof);
    await this.checkTotp(userId, code);
    await this.db.query('UPDATE users SET mfa_totp_secret_enc = NULL, mfa_enabled_at = NULL, mfa_last_counter = NULL WHERE id = $1', [userId]);
    await this.audit.record({ actorId: userId, action: 'auth.mfa_disabled' });
  }

  /** Verifies a TOTP code and records its counter so the same code cannot be used twice. */
  private async checkTotp(userId: string, code: string) {
    await this.limits.consume(RULES.totpAccount, userId);
    const u = await this.db.one<{ mfa_totp_secret_enc: string | null; mfa_last_counter: string | null }>(
      'SELECT mfa_totp_secret_enc, mfa_last_counter FROM users WHERE id = $1',
      [userId],
    );
    if (!u?.mfa_totp_secret_enc) throw Errors.invalidToken();
    const counter = verifyTotp(this.box.open(u.mfa_totp_secret_enc, userId), code);
    if (counter === null) throw Errors.invalidToken();
    const res = await this.db.query(
      'UPDATE users SET mfa_last_counter = $2 WHERE id = $1 AND (mfa_last_counter IS NULL OR mfa_last_counter < $2)',
      [userId, counter],
    );
    if (res.rowCount === 0) throw Errors.invalidToken();
  }

  // --- helpers ---

  /** mfa: the session was opened with a two-step code, which the admin dashboard requires. */
  private async createSession(tx: PoolClient, userId: string, deviceName: string | undefined, client: ClientInfo, mfa = false): Promise<TokenPair> {
    const refreshToken = randomToken();
    const s = await this.db.one<{ id: string }>(
      `INSERT INTO sessions (user_id, device_name, user_agent, ip, refresh_token_hash, expires_at, mfa_verified_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6), CASE WHEN $7 THEN now() END) RETURNING id`,
      [userId, deviceName?.slice(0, 100) || 'Unknown device', client.userAgent, client.ip, hashToken(refreshToken), this.config.REFRESH_TOKEN_TTL_DAYS, mfa],
      tx,
    );
    return this.pairFor(userId, s!.id, refreshToken);
  }

  private async pairFor(userId: string, sessionId: string, refreshToken: string): Promise<TokenPair> {
    return {
      accessToken: await this.tokens.signAccess({ userId, sessionId }),
      refreshToken,
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
      sessionId,
    };
  }

  private async issueOneTimeToken(userId: string, purpose: string, ttl: string, db: Queryable = this.db.pool) {
    const token = randomToken();
    await this.db.query(
      `INSERT INTO one_time_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, $3, now() + $4::interval)`,
      [hashToken(token), userId, purpose, ttl],
      db,
    );
    return token;
  }

  private async consumeOneTimeToken(tx: PoolClient, token: string, purpose: string): Promise<string> {
    const row = await this.db.one<{ user_id: string }>(
      `UPDATE one_time_tokens SET used_at = now()
        WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [hashToken(token), purpose],
      tx,
    );
    if (!row) throw Errors.invalidToken();
    return row.user_id;
  }
}
