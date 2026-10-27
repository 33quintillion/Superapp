import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { RateLimitService } from '../common/rate-limit.service';
import { APP_CONFIG, AppConfig } from '../config/config';

/** The shape RTCPeerConnection takes in its `iceServers` option. */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceConfig {
  iceServers: IceServer[];
  iceTransportPolicy: 'all' | 'relay';
  /** False when no relay could be issued: calls may then fail on restrictive networks. */
  relay: boolean;
  /** When the TURN credentials stop working; null without TURN. */
  expiresAt: string | null;
}

const PROVIDER_TIMEOUT_MS = 5000;

/**
 * Hands each call short-lived STUN/TURN settings. TURN credentials are issued per user
 * and expire, so a leaked set cannot be used to relay traffic for long. Providers:
 *
 * - coturn (self-hosted) with `use-auth-secret`: the "TURN REST API" scheme, where the
 *   username is `<expiry>:<userId>` and the password is HMAC-SHA1 of it with the shared
 *   secret. Nothing is called over the network.
 * - Twilio Network Traversal Service: POST /Accounts/{sid}/Tokens.
 * - Cloudflare Realtime TURN: POST /v1/turn/keys/{id}/credentials/generate-ice-servers.
 */
@Injectable()
export class IceService {
  private readonly logger = new Logger('Ice');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly limits: RateLimitService,
  ) {}

  async forUser(userId: string): Promise<IceConfig> {
    await this.limits.consume({ name: 'calls:ice', limit: 60, windowSeconds: 600 }, userId);
    const c = this.config;
    const stun: IceServer[] = c.STUN_URLS.length ? [{ urls: c.STUN_URLS }] : [];
    const ttl = c.TURN_CREDENTIAL_TTL_SECONDS;
    let turn: IceServer[] = [];
    try {
      if (c.TURN_PROVIDER === 'coturn') turn = [coturnCredentials(c.TURN_URLS, c.TURN_SHARED_SECRET!, userId, ttl)];
      else if (c.TURN_PROVIDER === 'twilio') turn = await this.twilio(ttl);
      else if (c.TURN_PROVIDER === 'cloudflare') turn = await this.cloudflare(ttl);
    } catch (err) {
      // A provider outage should not stop calls that can connect without a relay.
      this.logger.warn(`TURN credentials from ${c.TURN_PROVIDER} failed: ${(err as Error).message}`);
      turn = [];
    }
    const relay = turn.some((s) => s.urls.some((u) => u.startsWith('turn')));
    return {
      iceServers: dedupe([...stun, ...turn]),
      iceTransportPolicy: c.ICE_TRANSPORT_POLICY,
      relay,
      expiresAt: relay ? new Date(Date.now() + ttl * 1000).toISOString() : null,
    };
  }

  private async twilio(ttl: number): Promise<IceServer[]> {
    const c = this.config;
    const base = c.TWILIO_API_BASE ?? 'https://api.twilio.com';
    const res = await fetch(`${base}/2010-04-01/Accounts/${encodeURIComponent(c.TWILIO_ACCOUNT_SID!)}/Tokens.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${c.TWILIO_API_KEY_SID}:${c.TWILIO_API_KEY_SECRET}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Ttl: String(ttl) }).toString(),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Twilio answered ${res.status}`);
    const body = (await res.json()) as { ice_servers?: { urls?: string | string[]; url?: string; username?: string; credential?: string }[] };
    return (body.ice_servers ?? []).map((s) => normalise(s.urls ?? s.url, s.username, s.credential)).filter(isTurn);
  }

  private async cloudflare(ttl: number): Promise<IceServer[]> {
    const c = this.config;
    const base = c.CLOUDFLARE_TURN_API_BASE ?? 'https://rtc.live.cloudflare.com';
    const res = await fetch(`${base}/v1/turn/keys/${encodeURIComponent(c.CLOUDFLARE_TURN_KEY_ID!)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.CLOUDFLARE_TURN_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Cloudflare answered ${res.status}`);
    const body = (await res.json()) as { iceServers?: { urls?: string | string[]; username?: string; credential?: string }[] };
    // Browsers block port 53, so those URLs would only ever time out (Cloudflare's own advice).
    return (body.iceServers ?? [])
      .map((s) => normalise(s.urls, s.username, s.credential, (u) => !/:53(\?|$)/.test(u)))
      .filter(isTurn);
  }
}

/** coturn's `use-auth-secret` (TURN REST API) credentials. */
export function coturnCredentials(urls: string[], secret: string, userId: string, ttlSeconds: number, now = Date.now()): IceServer {
  const username = `${Math.floor(now / 1000) + ttlSeconds}:${userId}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { urls, username, credential };
}

function normalise(urls: string | string[] | undefined, username?: string, credential?: string, keep: (u: string) => boolean = () => true): IceServer {
  const list = (Array.isArray(urls) ? urls : urls ? [urls] : []).filter((u) => /^(stuns?|turns?):/.test(u) && keep(u));
  return { urls: list, ...(username ? { username } : {}), ...(credential ? { credential } : {}) };
}

/** Only relay entries with credentials; the provider's STUN entries are optional extras we keep too. */
function isTurn(s: IceServer) {
  return s.urls.length > 0 && (s.urls.every((u) => u.startsWith('stun')) || (!!s.username && !!s.credential));
}

function dedupe(list: IceServer[]): IceServer[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const key = JSON.stringify(s);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
