import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse } from '../common/zod';
import { Auth, AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/token.service';
import { AdminService } from '../admin/admin.service';
import { clientIdSchema } from '../messaging/messaging.schemas';
import { ENTITLEMENTS } from './entitlements';
import { LedgerService } from './ledger';
import { PaymentsService } from './payments.service';
import { SubscriptionsService } from './subscriptions.service';

const id = (v: string) => parse(z.uuid(), v);
const Onboarding = z.object({ country: z.string().regex(/^[A-Z]{2}$/, 'Use a two-letter country code such as GB') }).strict();
const Refund = z
  .object({
    amountMinor: z.number().int().min(1).max(100_000_000).optional(),
    reason: z.string().trim().max(300).default(''),
    clientId: clientIdSchema,
  })
  .strict();
const Page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(200).optional() });
const AdminPaymentsQuery = Page.extend({ status: z.enum(['requires_payment', 'succeeded', 'cancelled']).optional() });
const Subscribe = z.object({ planCode: z.string().max(40), clientId: clientIdSchema }).strict();
const CreatePlan = z
  .object({
    code: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'Use 2-40 letters, numbers or -'),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(''),
    priceMinor: z.number().int().min(1).max(100_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter code such as USD'),
    interval: z.enum(['month', 'year']),
    entitlements: z.array(z.enum(ENTITLEMENTS)).min(1).max(ENTITLEMENTS.length),
  })
  .strict();
const PlanState = z.object({ state: z.enum(['active', 'retired']) }).strict();

@Controller('v1')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly ledger: LedgerService,
    private readonly admin: AdminService,
  ) {}

  /**
   * Provider events. No session: the signature over the raw body is the authentication,
   * so this route needs the bytes exactly as sent.
   */
  @Post('payments/webhooks/stripe')
  @HttpCode(200)
  webhook(@Req() req: FastifyRequest & { rawBody?: Buffer }, @Headers('stripe-signature') signature?: string) {
    return this.payments.webhook(req.rawBody, signature);
  }

  // ---------------------------------------------------------------- payout account

  @Get('businesses/:id/payments/account')
  @UseGuards(AuthGuard)
  account(@Auth() a: AccessClaims, @Param('id') bid: string) {
    return this.payments.account(a.userId, id(bid));
  }

  @Post('businesses/:id/payments/account')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  onboarding(@Auth() a: AccessClaims, @Param('id') bid: string, @Body() body: unknown) {
    return this.payments.startOnboarding(a.userId, id(bid), parse(Onboarding, body).country);
  }

  @Get('businesses/:id/payments')
  @UseGuards(AuthGuard)
  businessPayments(@Auth() a: AccessClaims, @Param('id') bid: string, @Query() q: unknown) {
    const p = parse(Page, q);
    return this.payments.forBusiness(a.userId, id(bid), p.limit, p.cursor);
  }

  // ---------------------------------------------------------------- orders

  @Post('orders/:id/checkout')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  checkout(@Auth() a: AccessClaims, @Param('id') oid: string) {
    return this.payments.checkout(a.userId, id(oid));
  }

  @Get('orders/:id/payment')
  @UseGuards(AuthGuard)
  orderPayment(@Auth() a: AccessClaims, @Param('id') oid: string) {
    return this.payments.forOrder(a.userId, id(oid));
  }

  @Post('orders/:id/refunds')
  @UseGuards(AuthGuard)
  async refund(@Auth() a: AccessClaims, @Param('id') oid: string, @Body() body: unknown) {
    const refund = await this.payments.refund(a.userId, id(oid), parse(Refund, body));
    return { refund, ...(await this.payments.forOrder(a.userId, id(oid))) };
  }

  @Get('me/payments')
  @UseGuards(AuthGuard)
  mine(@Auth() a: AccessClaims, @Query() q: unknown) {
    const p = parse(Page, q);
    return this.payments.mine(a.userId, p.limit, p.cursor);
  }

  // ---------------------------------------------------------------- plans and subscriptions

  @Get('plans')
  @UseGuards(AuthGuard)
  plans() {
    return this.subscriptions.plans();
  }

  @Get('businesses/:id/subscription')
  @UseGuards(AuthGuard)
  subscription(@Auth() a: AccessClaims, @Param('id') bid: string) {
    return this.subscriptions.forBusiness(a.userId, id(bid));
  }

  @Post('businesses/:id/subscription')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  subscribe(@Auth() a: AccessClaims, @Param('id') bid: string, @Body() body: unknown) {
    const b = parse(Subscribe, body);
    return this.subscriptions.subscribe(a.userId, id(bid), b.planCode, b.clientId);
  }

  @Delete('businesses/:id/subscription')
  @UseGuards(AuthGuard)
  cancel(@Auth() a: AccessClaims, @Param('id') bid: string) {
    return this.subscriptions.setCancelAtPeriodEnd(a.userId, id(bid), true);
  }

  @Post('businesses/:id/subscription/resume')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  resume(@Auth() a: AccessClaims, @Param('id') bid: string) {
    return this.subscriptions.setCancelAtPeriodEnd(a.userId, id(bid), false);
  }

  @Post('businesses/:id/billing-portal')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  portal(@Auth() a: AccessClaims, @Param('id') bid: string) {
    return this.subscriptions.portal(a.userId, id(bid));
  }

  // ---------------------------------------------------------------- admin

  @Get('admin/payments')
  @UseGuards(AuthGuard)
  async adminPayments(@Auth() a: AccessClaims, @Query() q: unknown) {
    await this.admin.require(a, 'admin');
    const p = parse(AdminPaymentsQuery, q);
    return this.payments.all(p.status, p.limit, p.cursor);
  }

  @Get('admin/ledger')
  @UseGuards(AuthGuard)
  async adminLedger(@Auth() a: AccessClaims) {
    await this.admin.require(a, 'admin');
    const [balances, check] = await Promise.all([this.ledger.balances(), this.ledger.check()]);
    return { balances, check };
  }

  @Get('admin/plans')
  @UseGuards(AuthGuard)
  async adminPlans(@Auth() a: AccessClaims) {
    await this.admin.require(a, 'admin');
    return this.subscriptions.adminPlans();
  }

  @Post('admin/plans')
  @UseGuards(AuthGuard)
  async createPlan(@Auth() a: AccessClaims, @Body() body: unknown) {
    await this.admin.require(a, 'admin');
    return this.subscriptions.createPlan(a.userId, parse(CreatePlan, body));
  }

  @Post('admin/plans/:id/state')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async planState(@Auth() a: AccessClaims, @Param('id') pid: string, @Body() body: unknown) {
    await this.admin.require(a, 'admin');
    return this.subscriptions.setPlanState(a.userId, id(pid), parse(PlanState, body).state);
  }
}
