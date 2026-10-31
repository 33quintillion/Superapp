import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config/config';

/**
 * Passwords of the allowed length that top the lists of leaked passwords. Checked on every
 * new password, even with the online check off or unreachable.
 */
const COMMON = new Set([
  '1234567890', '0123456789', '12345678910', '123456789a', 'a123456789', '1q2w3e4r5t', '1qaz2wsx3edc', 'qwertyuiop', 'qwerty1234', 'qwerty12345',
  'asdfghjkl;', 'zxcvbnm123', 'password12', 'password123', 'password1234', 'passw0rd123', 'iloveyou12', 'iloveyou123', 'abcdefghij', 'abc1234567',
  'aaaaaaaaaa', '1111111111', '0000000000', '9876543210', 'qwertyuiop123', 'football123', 'baseball123', 'princess123', 'sunshine123', 'superman123',
  'welcome123', 'letmein123', 'trustno1234', 'starwars123', 'dragon1234', 'monkey12345', 'master12345', 'michael123', 'charlie123', 'jennifer123',
  'computer123', 'whatever123', 'administrator', 'changeme123', 'qazwsxedcrfv', 'q1w2e3r4t5y6', 'zaq12wsxcde3', '1q2w3e4r5t6y', 'p@ssw0rd123', 'passwordpassword',
]);

/** What the online check does: 'hibp' asks Have I Been Pwned's Pwned Passwords range API. */
export type BreachCheckMode = 'hibp' | 'off';

export const breachedPassword = () =>
  new AppError(HttpStatus.BAD_REQUEST, 'password_breached', 'This password has appeared in a data breach, so it’s easy to guess. Choose a different one.');

/**
 * Refuses new passwords that are known to have leaked. The online check uses k-anonymity:
 * only the first 5 characters of the password's SHA-1 leave the server, the service returns
 * every leaked hash starting with them (padded with fakes), and the match happens here. If
 * the service is slow or down, the password is allowed: an outage must not block sign-ups.
 */
@Injectable()
export class BreachedPasswordsService {
  private readonly log = new Logger('BreachedPasswords');

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async assertNotBreached(password: string): Promise<void> {
    if (COMMON.has(password.toLowerCase())) throw breachedPassword();
    if (this.config.PASSWORD_BREACH_CHECK === 'off') return;
    if (await this.seenInBreaches(password)) throw breachedPassword();
  }

  private async seenInBreaches(password: string): Promise<boolean> {
    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    try {
      const res = await fetch(`${this.config.PASSWORD_BREACH_API_URL.replace(/\/$/, '')}/range/${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'nexa-api' },
        signal: AbortSignal.timeout(this.config.PASSWORD_BREACH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      for (const line of (await res.text()).split('\n')) {
        const [hash, count] = line.trim().split(':');
        // Padding entries have a count of 0.
        if (hash === suffix && Number(count) > 0) return true;
      }
      return false;
    } catch (e) {
      this.log.warn(`Breached-password check unavailable, allowing the password: ${(e as Error).message}`);
      return false;
    }
  }
}
