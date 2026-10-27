import { Body, Controller, Delete, Get, HttpCode, Param, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/zod';
import { Auth, AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/token.service';
import { INTEGRATION_CATEGORIES, IntegrationsService, Scope, SCOPE_NAMES } from './integrations.service';

const slug = (v: string) => parse(z.string().regex(/^[a-z0-9][a-z0-9_-]{2,39}$/), v);
const Connect = z.object({ scopes: z.array(z.enum(SCOPE_NAMES as [string, ...string[]])).max(SCOPE_NAMES.length) }).strict();
const CatalogueQuery = z.object({ category: z.enum(INTEGRATION_CATEGORIES).optional() });

/** The integration catalogue (mini-apps phase 1) as people see it. Admin routes are in AdminController. */
@Controller('v1')
@UseGuards(AuthGuard)
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get('integrations')
  catalogue(@Auth() a: AccessClaims, @Query() q: unknown) {
    return this.integrations.catalogue(a.userId, parse(CatalogueQuery, q).category);
  }

  @Get('integrations/:slug')
  get(@Auth() a: AccessClaims, @Param('slug') s: string) {
    return this.integrations.get(a.userId, slug(s));
  }

  /** Grant (or change) the scopes this integration may use for me. */
  @Put('integrations/:slug/connection')
  connect(@Auth() a: AccessClaims, @Param('slug') s: string, @Body() body: unknown) {
    return this.integrations.connect(a.userId, slug(s), parse(Connect, body).scopes as Scope[]);
  }

  @Delete('integrations/:slug/connection')
  @HttpCode(204)
  async disconnect(@Auth() a: AccessClaims, @Param('slug') s: string) {
    await this.integrations.disconnect(a.userId, slug(s));
  }

  @Get('me/integrations')
  connected(@Auth() a: AccessClaims) {
    return this.integrations.connected(a.userId);
  }
}
