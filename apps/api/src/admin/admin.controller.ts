import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/zod';
import { Auth, AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/token.service';
import { INTEGRATION_CATEGORIES, IntegrationsService, SCOPE_NAMES } from '../integrations/integrations.service';
import { AdminService } from './admin.service';

const id = (v: string) => parse(z.uuid(), v);
const subjectType = z.enum(['user', 'message', 'post', 'comment', 'story', 'community', 'business', 'mini_app']);

const ReportsQuery = z.object({
  status: z.enum(['open', 'closed']).default('open'),
  subjectType: subjectType.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
const Resolve = z
  .object({
    decision: z.enum(['dismiss', 'action']),
    removeContent: z.boolean().default(false),
    suspendAuthor: z.boolean().default(false),
    note: z.string().trim().max(1000).default(''),
  })
  .strict();
const Reason = z.object({ reason: z.string().trim().max(500).default('') }).strict();
const SuspendReason = z.object({ reason: z.string().trim().min(1, 'Say why').max(500) }).strict();
const UsersQuery = z.object({ q: z.string().trim().max(254).default(''), limit: z.coerce.number().int().min(1).max(100).default(25) });
const BusinessesQuery = z.object({
  q: z.string().trim().max(100).optional(),
  state: z.enum(['active', 'suspended']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const BusinessAction = z.object({ action: z.enum(['verify', 'unverify', 'suspend', 'unsuspend']), reason: z.string().trim().max(500).default('') }).strict();
const Grant = z.object({ username: z.string().trim().toLowerCase().max(30) }).strict();
const AuditQuery = z.object({
  action: z.string().trim().max(100).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{2,39}$/, 'Use 3-40 letters, numbers, - or _');
const IntegrationFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000),
  category: z.enum(INTEGRATION_CATEGORIES),
  developerName: z.string().trim().min(1).max(120),
  developerContact: z.string().trim().min(3).max(254),
  homepageUrl: z.url({ protocol: /^https$/ }).max(500),
  scopes: z.array(z.enum(SCOPE_NAMES as [string, ...string[]])).max(SCOPE_NAMES.length),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Use a version like 1.2.0'),
};
const CreateIntegration = z
  .object({ slug, ...IntegrationFields, description: IntegrationFields.description.default(''), scopes: IntegrationFields.scopes.default([]), version: IntegrationFields.version.default('1.0.0') })
  .strict();
const IntegrationPatch = z.object(IntegrationFields).partial().strict();
const IntegrationState = z.object({ state: z.enum(['live', 'disabled', 'draft']), reason: z.string().trim().max(500).default('') }).strict();

/** Everything under /v1/admin checks platform staff, two-step and session freshness in AdminService.require. */
@Controller('v1/admin')
@UseGuards(AuthGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly integrations: IntegrationsService,
  ) {}

  @Get('overview')
  overview(@Auth() a: AccessClaims) {
    return this.admin.overview(a);
  }

  @Get('reports')
  reports(@Auth() a: AccessClaims, @Query() q: unknown) {
    return this.admin.reports(a, parse(ReportsQuery, q));
  }

  @Get('reports/:id')
  report(@Auth() a: AccessClaims, @Param('id') rid: string) {
    return this.admin.report(a, id(rid));
  }

  @Post('reports/:id/claim')
  @HttpCode(200)
  claim(@Auth() a: AccessClaims, @Param('id') rid: string) {
    return this.admin.claim(a, id(rid));
  }

  @Post('reports/:id/resolve')
  @HttpCode(200)
  resolve(@Auth() a: AccessClaims, @Param('id') rid: string, @Body() body: unknown) {
    return this.admin.resolve(a, id(rid), parse(Resolve, body));
  }

  @Get('users')
  users(@Auth() a: AccessClaims, @Query() q: unknown) {
    const p = parse(UsersQuery, q);
    return this.admin.users(a, p.q, p.limit);
  }

  @Post('users/:id/suspend')
  @HttpCode(200)
  suspend(@Auth() a: AccessClaims, @Param('id') uid: string, @Body() body: unknown) {
    return this.admin.setUserSuspended(a, id(uid), true, parse(SuspendReason, body).reason);
  }

  @Post('users/:id/unsuspend')
  @HttpCode(200)
  unsuspend(@Auth() a: AccessClaims, @Param('id') uid: string, @Body() body: unknown) {
    return this.admin.setUserSuspended(a, id(uid), false, parse(Reason, body ?? {}).reason);
  }

  @Get('businesses')
  businesses(@Auth() a: AccessClaims, @Query() q: unknown) {
    return this.admin.businessList(a, parse(BusinessesQuery, q));
  }

  @Post('businesses/:id/actions')
  @HttpCode(200)
  businessAction(@Auth() a: AccessClaims, @Param('id') bid: string, @Body() body: unknown) {
    const p = parse(BusinessAction, body);
    return this.admin.businessAction(a, id(bid), p.action, p.reason);
  }

  @Get('integrations')
  integrationList(@Auth() a: AccessClaims) {
    return this.admin.integrationList(a);
  }

  @Post('integrations')
  async createIntegration(@Auth() a: AccessClaims, @Body() body: unknown) {
    await this.admin.require(a, 'admin');
    return this.integrations.create(a.userId, parse(CreateIntegration, body) as Parameters<IntegrationsService['create']>[1]);
  }

  @Patch('integrations/:id')
  async updateIntegration(@Auth() a: AccessClaims, @Param('id') iid: string, @Body() body: unknown) {
    await this.admin.require(a, 'admin');
    return this.integrations.update(a.userId, id(iid), parse(IntegrationPatch, body) as Parameters<IntegrationsService['update']>[2]);
  }

  @Post('integrations/:id/state')
  @HttpCode(200)
  async integrationState(@Auth() a: AccessClaims, @Param('id') iid: string, @Body() body: unknown) {
    await this.admin.require(a, 'admin');
    const p = parse(IntegrationState, body);
    return this.integrations.setState(a.userId, id(iid), p.state, p.reason);
  }

  @Get('staff')
  staff(@Auth() a: AccessClaims) {
    return this.admin.staff(a);
  }

  @Post('staff')
  grant(@Auth() a: AccessClaims, @Body() body: unknown) {
    return this.admin.grantModerator(a, parse(Grant, body).username);
  }

  @Delete('staff/:userId')
  @HttpCode(204)
  async revoke(@Auth() a: AccessClaims, @Param('userId') uid: string) {
    await this.admin.revokeModerator(a, id(uid));
  }

  @Get('audit')
  audit(@Auth() a: AccessClaims, @Query() q: unknown) {
    return this.admin.auditLog(a, parse(AuditQuery, q));
  }
}
