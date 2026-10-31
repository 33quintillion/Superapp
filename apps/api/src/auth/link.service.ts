import { HttpStatus, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { AppError, Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { hashToken, randomToken, safeEqual } from '../crypto/tokens';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';
import type { ClientInfo } from './auth.guard';
import { AuthService, TokenPair } from './auth.service';

/** No 0/O, 1/I/L: the code is read off a screen and may be typed into a phone. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;
export const LINK_TTL_S = 120;

interface Pending {
  secretHash: string;
  status: 'pending' | 'approved';
  userId?: string;
  deviceName: string;
  userAgent: string | null;
  createdAt: number;
}

const RULES = {
  createIp: { name: 'link:create:ip', limit: 30, windowSeconds: 900 },
  lookupUser: { name: 'link:lookup:user', limit: 20, windowSeconds: 900 },
  collect: { name: 'link:collect', limit: 120, windowSeconds: 300 },
};

// Approve only a link still waiting, keeping its expiry. Returns 1 if this call approved it.
const APPROVE = `
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
local d = cjson.decode(v)
if d.status ~= 'pending' then return 0 end
d.status = 'approved'
d.userId = ARGV[1]
redis.call('SET', KEYS[1], cjson.encode(d), 'KEEPTTL')
return 1`;

// Hand over an approved link once: read and delete in one step.
const TAKE = `
local v = redis.call('GET', KEYS[1])
if not v then return nil end
local d = cjson.decode(v)
if d.status == 'approved' then redis.call('DEL', KEYS[1]) end
return v`;

export function normalizeLinkCode(code: string) {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * Linking a computer to a phone, as WhatsApp Web does. The computer asks for a short code and
 * shows it (as a QR code and as text). The person, already signed in on their phone, scans or
 * types it and confirms what they're linking. The computer, which alone holds the matching
 * secret, then collects its own session. Codes last two minutes and work once.
 */
@Injectable()
export class LinkService {
  constructor(
    private readonly redis: RedisService,
    private readonly db: DatabaseService,
    private readonly limits: RateLimitService,
    private readonly auth: AuthService,
  ) {}

  private key = (code: string) => `link:${normalizeLinkCode(code)}`;

  async create(deviceName: string | undefined, client: ClientInfo) {
    await this.limits.consume(RULES.createIp, client.ip ?? 'unknown');
    const secret = randomToken();
    const pending: Pending = {
      secretHash: hashToken(secret),
      status: 'pending',
      deviceName: deviceName?.slice(0, 100) || 'Web browser',
      userAgent: client.userAgent?.slice(0, 300) ?? null,
      createdAt: Date.now(),
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
      if ((await this.redis.client.set(this.key(code), JSON.stringify(pending), 'EX', LINK_TTL_S, 'NX')) === 'OK') {
        return { code, secret, expiresIn: LINK_TTL_S };
      }
    }
    throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'link_unavailable', 'Couldn’t make a code. Try again.');
  }

  /** What the phone shows before linking: "Link Web browser (Chrome on Windows)?" */
  async describe(userId: string, code: string) {
    await this.limits.consume(RULES.lookupUser, userId);
    const d = await this.read(code);
    if (!d || d.status !== 'pending') throw Errors.invalidToken();
    return { deviceName: d.deviceName, browser: describeAgent(d.userAgent), expiresInSeconds: Math.max(0, LINK_TTL_S - Math.round((Date.now() - d.createdAt) / 1000)) };
  }

  async approve(userId: string, code: string) {
    await this.limits.consume(RULES.lookupUser, userId);
    const u = await this.db.one<{ state: string }>('SELECT state FROM users WHERE id = $1', [userId]);
    if (u?.state !== 'active') throw Errors.forbidden('This account can’t link devices');
    const ok = await this.redis.client.eval(APPROVE, 1, this.key(code), userId);
    if (ok !== 1) throw Errors.invalidToken();
  }

  /** The computer asks every couple of seconds; once approved it gets its session, once. */
  async collect(code: string, secret: string, client: ClientInfo): Promise<{ status: 'pending'; expiresIn: number } | TokenPair> {
    await this.limits.consume(RULES.collect, client.ip ?? 'unknown');
    const raw = (await this.redis.client.eval(TAKE, 1, this.key(code))) as string | null;
    if (!raw) throw Errors.invalidToken();
    const d = JSON.parse(raw) as Pending;
    if (!safeEqual(d.secretHash, hashToken(secret))) {
      // Someone without the secret raced to collect: put an approved link back for its owner.
      if (d.status === 'approved') await this.redis.client.set(this.key(code), raw, 'EX', 30);
      throw Errors.invalidToken();
    }
    if (d.status === 'pending') {
      const ttl = await this.redis.client.ttl(this.key(code));
      return { status: 'pending', expiresIn: Math.max(0, ttl) };
    }
    return this.auth.openLinkedSession(d.userId!, d.deviceName, client);
  }

  private async read(code: string): Promise<Pending | null> {
    const raw = await this.redis.client.get(this.key(code));
    return raw ? (JSON.parse(raw) as Pending) : null;
  }
}

/** "Chrome on Windows" from a user agent, for the confirmation on the phone. */
export function describeAgent(ua: string | null): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os;
}
