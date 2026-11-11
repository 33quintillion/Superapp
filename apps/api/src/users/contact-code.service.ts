import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { DatabaseService } from '../database/database.service';

/** No 0/O, 1/I/L: the code may be read off a screen or a printed card and typed. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const LENGTH = 10;

export const CONTACT_PREFIX = 'SUPERAPP-ADD:';

const RULES = {
  lookup: { name: 'contact-code:lookup', limit: 60, windowSeconds: 900 },
  reset: { name: 'contact-code:reset', limit: 10, windowSeconds: 3600 },
};

export function normalizeContactCode(code: string) {
  return code.toUpperCase().replace(/^SUPERAPP-ADD:/, '').replace(/[^0-9A-Z]/g, '');
}

/**
 * A personal QR code that opens a chat with its owner. It works without a username (people
 * who signed up with only a phone number) and never shows the phone number. Blocks hide it.
 */
@Injectable()
export class ContactCodeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly limits: RateLimitService,
  ) {}

  /** This person's code, made the first time it's asked for. */
  async mine(userId: string) {
    const r = await this.db.one<{ contact_code: string | null }>('SELECT contact_code FROM users WHERE id = $1', [userId]);
    return this.describe(r?.contact_code ?? (await this.assign(userId, false)));
  }

  /** A new code; the old one stops working at once. */
  async reset(userId: string) {
    await this.limits.consume(RULES.reset, userId);
    return this.describe(await this.assign(userId, true));
  }

  /** Who a scanned code belongs to. 404 for unknown, reset, closed or blocked either way. */
  async lookup(viewerId: string, code: string) {
    await this.limits.consume(RULES.lookup, viewerId);
    const c = normalizeContactCode(code);
    if (c.length !== LENGTH) throw Errors.notFound('User');
    const u = await this.db.one<{ id: string; username: string | null; display_name: string; avatar_media_id: string | null }>(
      `SELECT u.id, u.username, u.display_name, u.avatar_media_id FROM users u
        WHERE u.contact_code = $1 AND u.state = 'active' AND NOT blocked_either_way($2, u.id)`,
      [c, viewerId],
    );
    if (!u) throw Errors.notFound('User');
    return { id: u.id, username: u.username, displayName: u.display_name, avatarMediaId: u.avatar_media_id, self: u.id === viewerId };
  }

  private describe(code: string) {
    return { code, qr: `${CONTACT_PREFIX}${code}` };
  }

  private async assign(userId: string, replace: boolean): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
      try {
        const r = await this.db.one<{ contact_code: string }>(
          `UPDATE users SET contact_code = CASE WHEN $3 OR contact_code IS NULL THEN $2 ELSE contact_code END
            WHERE id = $1 AND state = 'active' RETURNING contact_code`,
          [userId, code, replace],
        );
        if (!r) throw Errors.notFound('User');
        return r.contact_code;
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err; // taken: try another
      }
    }
    throw Errors.conflict('code_unavailable', 'Couldn’t make a code. Try again.');
  }
}
