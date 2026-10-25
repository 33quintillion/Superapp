import { CanActivate, createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { DatabaseService } from '../database/database.service';
import { Errors } from '../common/errors';
import { AccessClaims, TokenService } from './token.service';

type AuthedRequest = FastifyRequest & { auth?: AccessClaims };

/**
 * Validates the bearer token and that its session is still live and its user active.
 * The DB check means "log out this device" and password resets take effect immediately,
 * not when the access token expires.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly db: DatabaseService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw Errors.unauthorized();
    const claims = await this.tokens.verifyAccess(header.slice(7));
    if (!claims) throw Errors.unauthorized('Invalid or expired access token');
    const row = await this.db.one(
      `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.state = 'active'`,
      [claims.sessionId, claims.userId],
    );
    if (!row) throw Errors.unauthorized('Session is no longer valid');
    req.auth = claims;
    await this.db.query('UPDATE sessions SET last_used_at = now() WHERE id = $1 AND last_used_at < now() - interval \'1 minute\'', [claims.sessionId]);
    return true;
  }
}

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AccessClaims => {
  const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth) throw Errors.unauthorized();
  return auth;
});

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export const Client = createParamDecorator((_: unknown, ctx: ExecutionContext): ClientInfo => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  const ua = req.headers['user-agent'];
  return { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null };
});
