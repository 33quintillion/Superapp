import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { parse } from '../common/zod';
import { Auth, AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/token.service';
import { clientIdSchema } from '../messaging/messaging.schemas';
import { BookingsService } from './bookings.service';
import { BusinessesService, CATEGORIES } from './businesses.service';
import { MAX_ORDER_LINES, OrdersService } from './orders.service';

const id = (v: string) => parse(z.uuid(), v);
const handle = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{2,39}$/, 'Use 3-40 letters, numbers, - or _');
const businessRef = (v: string) => parse(z.union([z.uuid(), handle]), v);

const money = z.number().int().min(0).max(100_000_000);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');

const BusinessFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).default(''),
  category: z.enum(CATEGORIES),
  contactEmail: z.string().trim().toLowerCase().max(254).pipe(z.email()).nullable().optional(),
  phone: z
    .string()
    .regex(/^\+[1-9][0-9]{6,14}$/, 'Use international format, e.g. +447700900123')
    .nullable()
    .optional(),
  address: z.string().trim().max(300).default(''),
  timeZone: z.string().min(1).max(64),
};
const CreateBusiness = z.object({ handle, currency: z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter code such as USD'), ...BusinessFields }).strict();
const BusinessPatch = z
  .object({
    name: BusinessFields.name,
    description: z.string().trim().max(2000),
    category: BusinessFields.category,
    contactEmail: BusinessFields.contactEmail,
    phone: BusinessFields.phone,
    address: z.string().trim().max(300),
    timeZone: BusinessFields.timeZone,
    ordersEnabled: z.boolean(),
    bookingsEnabled: z.boolean(),
    inPersonPayments: z.boolean(),
  })
  .partial()
  .strict();
const SearchQuery = z.object({ q: z.string().trim().max(100).optional(), category: z.enum(CATEGORIES).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });

const StaffRoleInput = z.enum(['manager', 'staff']);
const Invite = z.object({ username: z.string().trim().toLowerCase().max(30), role: StaffRoleInput }).strict();
const RolePatch = z.object({ role: StaffRoleInput }).strict();
const Transfer = z.object({ userId: z.uuid() }).strict();
const Hours = z
  .object({ hours: z.array(z.object({ weekday: z.number().int().min(0).max(6), opens: time, closes: time }).strict()).max(28) })
  .strict();

const ItemFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000),
  priceMinor: money,
  available: z.boolean(),
  stock: z.number().int().min(0).max(1_000_000).nullable(),
  position: z.number().int().min(0).max(10_000),
};
const CreateItem = z
  .object({ ...ItemFields, description: ItemFields.description.default(''), available: ItemFields.available.default(true), stock: ItemFields.stock.default(null), position: ItemFields.position.default(0) })
  .strict();
const ItemPatch = z.object(ItemFields).partial().strict();

const PlaceOrder = z
  .object({
    clientId: clientIdSchema,
    items: z
      .array(z.object({ itemId: z.uuid(), quantity: z.number().int().min(1).max(99) }).strict())
      .min(1, 'Add something to your order')
      .max(MAX_ORDER_LINES),
    note: z.string().trim().max(500).default(''),
    payment: z.enum(['pay_in_person', 'online']).default('pay_in_person'),
  })
  .strict();
const orderStatus = z.enum(['placed', 'accepted', 'ready', 'completed', 'cancelled', 'rejected']);
const OrderStatusBody = z.object({ status: z.enum(['accepted', 'rejected', 'ready', 'completed', 'cancelled']), reason: z.string().trim().max(300).default('') }).strict();
const OrdersQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',') : undefined))
    .pipe(z.array(orderStatus).optional()),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});

const ServiceFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000),
  durationMinutes: z.number().int().min(5).max(480),
  priceMinor: money,
  capacity: z.number().int().min(1).max(100),
  active: z.boolean(),
};
const CreateService = z
  .object({ ...ServiceFields, description: ServiceFields.description.default(''), priceMinor: money.default(0), capacity: ServiceFields.capacity.default(1), active: ServiceFields.active.default(true) })
  .strict();
const ServicePatch = z.object(ServiceFields).partial().strict();
const SlotsQuery = z.object({ date: z.iso.date() });
const Book = z.object({ serviceId: z.uuid(), startsAt: z.iso.datetime({ offset: true }), clientId: clientIdSchema, note: z.string().trim().max(500).default('') }).strict();
const BookingOutcome = z.object({ status: z.enum(['completed', 'no_show']) }).strict();
const RangeQuery = z
  .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
  .refine((r) => Date.parse(r.to) > Date.parse(r.from) && Date.parse(r.to) - Date.parse(r.from) <= 62 * 86400_000, 'Pick a range of up to 62 days');

@Controller('v1')
@UseGuards(AuthGuard)
export class BusinessController {
  constructor(
    private readonly businesses: BusinessesService,
    private readonly orders: OrdersService,
    private readonly bookings: BookingsService,
  ) {}

  // ---------------------------------------------------------------- businesses

  @Post('businesses')
  create(@Auth() a: AccessClaims, @Body() body: unknown) {
    return this.businesses.create(a.userId, parse(CreateBusiness, body));
  }

  @Get('businesses')
  search(@Auth() a: AccessClaims, @Query() q: unknown) {
    const p = parse(SearchQuery, q);
    return this.businesses.search(a.userId, p.q, p.category, p.limit);
  }

  @Get('me/businesses')
  mine(@Auth() a: AccessClaims) {
    return this.businesses.mine(a.userId);
  }

  @Get('businesses/:ref')
  get(@Auth() a: AccessClaims, @Param('ref') ref: string) {
    return this.businesses.get(a.userId, businessRef(ref));
  }

  @Patch('businesses/:id')
  update(@Auth() a: AccessClaims, @Param('id') bid: string, @Body() body: unknown) {
    return this.businesses.update(a.userId, id(bid), parse(BusinessPatch, body));
  }

  @Delete('businesses/:id')
  @HttpCode(204)
  async remove(@Auth() a: AccessClaims, @Param('id') bid: string) {
    await this.businesses.delete(a.userId, id(bid));
  }

  @Get('businesses/:ref/hours')
  async hours(@Auth() a: AccessClaims, @Param('ref') ref: string) {
    const b = await this.businesses.get(a.userId, businessRef(ref));
    return this.businesses.hours(b.id);
  }

  @Put('businesses/:id/hours')
  setHours(@Auth() a: AccessClaims, @Param('id') bid: string, @Body() body: unknown) {
    return this.businesses.setHours(a.userId, id(bid), parse(Hours, body).hours);
  }

  // ---------------------------------------------------------------- staff

  @Get('businesses/:id/staff')
  staff(@Auth() a: AccessClaims, @Param('id') bid: string) {
    return this.businesses.staff(a.userId, id(bid));
  }

  @Post('businesses/:id/staff')
  invite(@Auth() a: AccessClaims, @Param('id') bid: string, @Body() body: unknown) {
    const p = parse(Invite, body);
    return this.businesses.invite(a.userId, id(bid), p.username, p.role);
  }

  @Post('businesses/:id/staff/accept')
  @HttpCode(200)
  accept(@Auth() a: AccessClaims, @Param('id') bid: string) {
    return this.businesses.acceptInvite(a.userId, id(bid));
  }

  @Patch('businesses/:id/staff/:userId')
  changeRole(@Auth() a: AccessClaims, @Param('id') bid: string, @Param('userId') uid: string, @Body() body: unknown) {
    return this.businesses.changeRole(a.userId, id(bid), id(uid), parse(RolePatch, body).role);
  }

  @Delete('businesses/:id/staff/:userId')
  @HttpCode(204)
  async removeStaff(@Auth() a: AccessClaims, @Param('id') bid: string, @Param('userId') uid: string) {
    await this.businesses.removeStaff(a.userId, id(bid), id(uid));
  }

  @Post('businesses/:id/transfer')
  @HttpCode(200)
  transfer(@Auth() a: AccessClaims, @Param('id') bid: string, @Body() body: unknown) {
    return this.businesses.transferOwnership(a.userId, id(bid), parse(Transfer, body).userId);
  }

  // ---------------------------------------------------------------- catalogue

  @Get('businesses/:ref/items')
  items(@Auth() a: AccessClaims, @Param('ref') ref: string, @Query('all') all?: string) {
    return this.orders.items(a.userId, businessRef(ref), all === 'true');
  }

  @Post('businesses/:id/items')
  createItem(@Auth() a: AccessClaims, @Param('id') bid: string, @Body() body: unknown) {
    return this.orders.createItem(a.userId, id(bid), parse(CreateItem, body));
  }

  @Patch('businesses/:id/items/:itemId')
  updateItem(@Auth() a: AccessClaims, @Param('id') bid: string, @Param('itemId') iid: string, @Body() body: unknown) {
    return this.orders.updateItem(a.userId, id(bid), id(iid), parse(ItemPatch, body));
  }

  @Delete('businesses/:id/items/:itemId')
  @HttpCode(204)
  async archiveItem(@Auth() a: AccessClaims, @Param('id') bid: string, @Param('itemId') iid: string) {
    await this.orders.archiveItem(a.userId, id(bid), id(iid));
  }

  // ---------------------------------------------------------------- orders

  @Post('businesses/:ref/orders')
  async placeOrder(@Auth() a: AccessClaims, @Param('ref') ref: string, @Body() body: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    const out = await this.orders.place(a.userId, businessRef(ref), parse(PlaceOrder, body));
    res.status(out.created ? 201 : 200);
    return out.order;
  }

  @Get('businesses/:id/orders')
  businessOrders(@Auth() a: AccessClaims, @Param('id') bid: string, @Query() q: unknown) {
    const p = parse(OrdersQuery, q);
    return this.orders.forBusiness(a.userId, id(bid), p.status, p.limit, p.cursor);
  }

  @Get('orders')
  myOrders(@Auth() a: AccessClaims, @Query() q: unknown) {
    const p = parse(OrdersQuery.omit({ status: true }), q);
    return this.orders.mine(a.userId, p.limit, p.cursor);
  }

  @Get('orders/:id')
  order(@Auth() a: AccessClaims, @Param('id') oid: string) {
    return this.orders.get(a.userId, id(oid));
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  cancelOrder(@Auth() a: AccessClaims, @Param('id') oid: string) {
    return this.orders.cancelByCustomer(a.userId, id(oid));
  }

  @Post('orders/:id/status')
  @HttpCode(200)
  orderStatus(@Auth() a: AccessClaims, @Param('id') oid: string, @Body() body: unknown) {
    const p = parse(OrderStatusBody, body);
    return this.orders.setStatus(a.userId, id(oid), p.status, p.reason);
  }

  // ---------------------------------------------------------------- bookings

  @Get('businesses/:ref/services')
  services(@Auth() a: AccessClaims, @Param('ref') ref: string, @Query('all') all?: string) {
    return this.bookings.services(a.userId, businessRef(ref), all === 'true');
  }

  @Post('businesses/:id/services')
  createService(@Auth() a: AccessClaims, @Param('id') bid: string, @Body() body: unknown) {
    return this.bookings.createService(a.userId, id(bid), parse(CreateService, body));
  }

  @Patch('businesses/:id/services/:serviceId')
  updateService(@Auth() a: AccessClaims, @Param('id') bid: string, @Param('serviceId') sid: string, @Body() body: unknown) {
    return this.bookings.updateService(a.userId, id(bid), id(sid), parse(ServicePatch, body));
  }

  @Delete('businesses/:id/services/:serviceId')
  @HttpCode(204)
  async archiveService(@Auth() a: AccessClaims, @Param('id') bid: string, @Param('serviceId') sid: string) {
    await this.bookings.archiveService(a.userId, id(bid), id(sid));
  }

  @Get('businesses/:ref/services/:serviceId/slots')
  slots(@Auth() a: AccessClaims, @Param('ref') ref: string, @Param('serviceId') sid: string, @Query() q: unknown) {
    return this.bookings.slots(a.userId, businessRef(ref), id(sid), parse(SlotsQuery, q).date);
  }

  @Post('businesses/:ref/bookings')
  async book(@Auth() a: AccessClaims, @Param('ref') ref: string, @Body() body: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    const out = await this.bookings.book(a.userId, businessRef(ref), parse(Book, body));
    res.status(out.created ? 201 : 200);
    return out.booking;
  }

  @Get('businesses/:id/bookings')
  businessBookings(@Auth() a: AccessClaims, @Param('id') bid: string, @Query() q: unknown) {
    const p = parse(RangeQuery, q);
    return this.bookings.forBusiness(a.userId, id(bid), p.from, p.to);
  }

  @Get('bookings')
  myBookings(@Auth() a: AccessClaims, @Query('upcoming') upcoming?: string) {
    return this.bookings.mine(a.userId, upcoming !== 'false');
  }

  @Get('bookings/:id')
  booking(@Auth() a: AccessClaims, @Param('id') kid: string) {
    return this.bookings.get(a.userId, id(kid));
  }

  @Post('bookings/:id/cancel')
  @HttpCode(200)
  cancelBooking(@Auth() a: AccessClaims, @Param('id') kid: string) {
    return this.bookings.cancel(a.userId, id(kid));
  }

  @Post('bookings/:id/outcome')
  @HttpCode(200)
  bookingOutcome(@Auth() a: AccessClaims, @Param('id') kid: string, @Body() body: unknown) {
    return this.bookings.setOutcome(a.userId, id(kid), parse(BookingOutcome, body).status);
  }
}
