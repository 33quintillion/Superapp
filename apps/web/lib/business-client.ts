// Types and helpers for the business, orders, bookings, integrations and admin screens.
// Calls go through the same proxy as chat (chatApi).
import type { UserSummary } from './social-client';

export type StaffRole = 'owner' | 'manager' | 'staff';

export interface Business {
  id: string;
  handle: string;
  name: string;
  description: string;
  category: string;
  contactEmail: string | null;
  phone: string | null;
  address: string;
  timeZone: string;
  currency: string;
  ordersEnabled: boolean;
  bookingsEnabled: boolean;
  /** How customers can pay for orders. */
  payments: { online: boolean; inPerson: boolean };
  verified: boolean;
  state: 'active' | 'suspended' | 'deleted';
  suspensionReason: string | null;
  createdAt: string;
  myRole: StaffRole | null;
  permissions: string[];
  invited: { role: StaffRole } | null;
}

export interface Item {
  id: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  available: boolean;
  stock: number | null;
  position: number;
}

export type OrderStatus = 'pending_payment' | 'placed' | 'accepted' | 'ready' | 'completed' | 'cancelled' | 'rejected';
export type PaymentStatus = 'unpaid' | 'paid' | 'partially_refunded' | 'refunded' | 'cancelled';

export interface Order {
  id: string;
  business: { id: string; handle: string; name: string };
  customer?: UserSummary | null;
  status: OrderStatus;
  statusReason: string;
  payment: 'pay_in_person' | 'online';
  /** Online orders only. */
  paymentStatus: PaymentStatus | null;
  refundedMinor: number;
  note: string;
  items: { itemId: string | null; name: string; unitPriceMinor: number; quantity: number }[];
  totalMinor: number;
  currency: string;
  createdAt: string;
}

export interface Service {
  id: string;
  name: string;
  description: string;
  durationMinutes: number;
  priceMinor: number;
  currency: string;
  capacity: number;
  active: boolean;
  /** Paid by card when booking; 0 means everything is paid in person. */
  depositMinor: number;
  /** The deposit is refunded if the customer cancels at least this many hours before. */
  freeCancelHours: number;
}

export interface Slot {
  startsAt: string;
  endsAt: string;
  remaining: number;
}

export interface Booking {
  id: string;
  business: { id: string; handle: string; name: string; timeZone: string };
  service: { id: string; name: string };
  customer?: UserSummary | null;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  cancelledBy: 'customer' | 'business' | null;
  note: string;
  currency: string;
  priceMinor: number;
  deposit: { amountMinor: number; status: PaymentStatus | null; refundedMinor: number; freeCancelUntil: string | null; refundDue: boolean } | null;
}

export type BookingStatus = 'pending_payment' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';

export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  pending_payment: 'Waiting for the deposit',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  completed: 'Came',
  no_show: 'Didn’t come',
};

/** What happens to a paid deposit if the customer cancels now. */
export function cancellationNote(k: Booking): string | null {
  if (!k.deposit || k.deposit.status !== 'paid') return null;
  const until = k.deposit.freeCancelUntil ? Date.parse(k.deposit.freeCancelUntil) : 0;
  return until > Date.now()
    ? `Cancel before ${localTime(k.deposit.freeCancelUntil!, k.business.timeZone, true)} to get your ${money(k.deposit.amountMinor, k.currency)} deposit back.`
    : `The free cancellation time has passed: if you cancel, the business keeps your ${money(k.deposit.amountMinor, k.currency)} deposit.`;
}

export interface StaffMember {
  user: UserSummary;
  role: StaffRole;
  state: 'invited' | 'active';
  since: string;
}

export interface Integration {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  developer: { name: string; contact?: string };
  homepageUrl: string;
  scopes: { scope: string; description: string }[];
  version: string;
  state: 'draft' | 'live' | 'disabled';
  disabledReason?: string | null;
  connections?: number;
  grant: { scopes: string[]; grantedAt: string; active: boolean } | null;
}

export const CATEGORIES = ['food', 'retail', 'beauty', 'health', 'services', 'education', 'entertainment', 'other'] as const;

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: 'Waiting for payment',
  placed: 'Waiting for the business',
  accepted: 'Being prepared',
  ready: 'Ready to collect',
  completed: 'Collected',
  cancelled: 'Cancelled',
  rejected: 'Declined',
};

/** What staff can move an order to next, with the button label. Mirrors the API's rules. */
export const NEXT_STEPS: Record<OrderStatus, { to: OrderStatus; label: string }[]> = {
  pending_payment: [],
  placed: [
    { to: 'accepted', label: 'Accept' },
    { to: 'rejected', label: 'Decline' },
  ],
  accepted: [
    { to: 'ready', label: 'Mark ready' },
    { to: 'cancelled', label: 'Cancel' },
  ],
  ready: [
    { to: 'completed', label: 'Collected' },
    { to: 'cancelled', label: 'Cancel' },
  ],
  completed: [],
  cancelled: [],
  rejected: [],
};

export const PAYMENT_LABEL: Record<PaymentStatus, string> = {
  unpaid: 'Not paid yet',
  paid: 'Paid online',
  partially_refunded: 'Partly refunded',
  refunded: 'Refunded',
  cancelled: 'Payment cancelled',
};

export interface Refund {
  id: string;
  amountMinor: number;
  status: 'pending' | 'succeeded' | 'failed';
  origin: 'staff' | 'auto' | 'provider';
  reason: string;
  createdAt: string;
}

export interface Payment {
  id: string;
  orderId: string | null;
  bookingId: string | null;
  status: PaymentStatus;
  amountMinor: number;
  refundedMinor: number;
  /** Held back by the customer's bank while a dispute is open or after it was lost. */
  disputedMinor: number;
  refundableMinor: number;
  disputeStatus?: DisputeStatus | null;
  feeMinor: number;
  currency: string;
  createdAt: string;
  paidAt: string | null;
  refunds?: Refund[];
  business?: { id: string; handle: string; name: string };
}

export type DisputeStatus = 'warning_needs_response' | 'warning_under_review' | 'warning_closed' | 'needs_response' | 'under_review' | 'won' | 'lost';

export const DISPUTE_STATUS_LABEL: Record<DisputeStatus, string> = {
  warning_needs_response: 'Bank enquiry: please respond',
  warning_under_review: 'Bank enquiry: response sent',
  warning_closed: 'Bank enquiry closed',
  needs_response: 'Disputed: please respond',
  under_review: 'Disputed: the bank is deciding',
  won: 'Dispute won',
  lost: 'Dispute lost',
};

export interface Dispute {
  id: string;
  paymentId: string;
  orderId: string | null;
  bookingId: string | null;
  amountMinor: number;
  currency: string;
  reason: string;
  status: DisputeStatus;
  open: boolean;
  canRespond: boolean;
  evidenceDueBy: string | null;
  evidenceSubmittedAt: string | null;
  createdAt: string;
}

export interface Payout {
  id: string;
  amountMinor: number;
  currency: string;
  status: 'pending' | 'in_transit' | 'paid' | 'failed' | 'canceled';
  arrivalDate: string | null;
  createdAt: string;
}

export interface PlanChangePreview {
  plan: Plan;
  from: Plan;
  /** Charged now; below zero is credit towards later invoices. */
  amountDueNowMinor: number;
  currency: string;
  intervalChanges: boolean;
}

export interface PayoutAccount {
  enabled: boolean;
  provider: string | null;
  connected: boolean;
  country: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  onlinePayments: boolean;
}

export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  interval: 'month' | 'year';
  entitlements: string[];
  state: 'draft' | 'active' | 'retired';
}

export interface BusinessSubscription {
  enabled: boolean;
  subscription: { id: string; status: string; plan: Plan; cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null; entitled: boolean } | null;
  entitlements: string[];
  limits: { staff: number; catalogue: number };
}

export const ENTITLEMENT_LABEL: Record<string, string> = {
  'staff.extra': 'Up to 100 staff (instead of 10)',
  'catalogue.extra': 'Up to 5,000 catalogue items (instead of 500)',
};

export function money(minor: number, currency: string) {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(minor / 10 ** fractionDigits(currency));
}

/** Converts what someone typed ("2.50") into minor units for the currency. */
export function toMinor(input: string, currency: string): number {
  const n = Number(input.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw new Error('Enter a price such as 2.50');
  return Math.round(n * 10 ** fractionDigits(currency));
}

function fractionDigits(currency: string) {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** A time in the business's own time zone, which is what its opening hours are in. */
export function localTime(iso: string, timeZone: string, withDate = false) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    ...(withDate ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
  }).format(new Date(iso));
}

export function todayIn(timeZone: string, plusDays = 0) {
  const d = new Date(Date.now() + plusDays * 86400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
