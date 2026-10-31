import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { APP_CONFIG, AppConfig } from '../config/config';
import { AppError, Errors } from '../common/errors';
import { hashToken } from '../crypto/tokens';
import { RedisService } from '../redis/redis.service';

/** Google's public keys for Firebase Auth ID tokens. */
const GOOGLE_JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const E164 = /^\+[1-9][0-9]{6,14}$/;

export const PhoneErrors = {
  unavailable: () => new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'phone_signin_unavailable', 'Phone sign-in is not set up yet'),
  stale: () => new AppError(HttpStatus.UNAUTHORIZED, 'phone_code_expired', 'That code was checked too long ago. Ask for a new code.'),
  country: () => new AppError(HttpStatus.BAD_REQUEST, 'phone_country_not_supported', 'Phone numbers from this country are not supported yet'),
};

/**
 * Checks the proof that someone owns a phone number. The app asks Firebase Auth to text a
 * code; once the code is entered, Firebase hands the app a signed ID token naming the number.
 * The API accepts it only if Google signed it for this project, it came from phone sign-in,
 * the code was entered recently, and the token hasn't been used here before.
 */
@Injectable()
export class PhoneTokenService {
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly redis: RedisService,
  ) {
    if (config.FIREBASE_PROJECT_ID) {
      this.jwks = createRemoteJWKSet(new URL(config.FIREBASE_JWKS_URL ?? GOOGLE_JWKS), { timeoutDuration: 5000, cooldownDuration: 30_000 });
    }
  }

  get enabled() {
    return Boolean(this.jwks);
  }

  /** Returns the verified number in E.164 form. Each token is accepted once. */
  async verify(idToken: string): Promise<string> {
    if (!this.jwks) throw PhoneErrors.unavailable();
    const project = this.config.FIREBASE_PROJECT_ID as string;
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, this.jwks, {
        algorithms: ['RS256'],
        issuer: `https://securetoken.google.com/${project}`,
        audience: project,
        clockTolerance: 30,
      }));
    } catch {
      throw Errors.invalidToken();
    }
    const firebase = payload.firebase as { sign_in_provider?: unknown } | undefined;
    const phone = payload.phone_number;
    if (!payload.sub || firebase?.sign_in_provider !== 'phone' || typeof phone !== 'string' || !E164.test(phone)) throw Errors.invalidToken();
    const now = Math.floor(Date.now() / 1000);
    const authTime = typeof payload.auth_time === 'number' ? payload.auth_time : 0;
    if (authTime > now + 30) throw Errors.invalidToken();
    if (now - authTime > this.config.PHONE_CODE_MAX_AGE_SECONDS) throw PhoneErrors.stale();
    if (!this.config.PHONE_COUNTRY_CODES.some((c) => phone.startsWith(c))) throw PhoneErrors.country();
    // ID tokens live an hour; remembering each one that long stops it being replayed.
    const first = await this.redis.client.set(`phone-token:${hashToken(idToken)}`, '1', 'EX', 3700, 'NX');
    if (first !== 'OK') throw Errors.invalidToken();
    return phone;
  }
}
