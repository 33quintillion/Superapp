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

export type OrderStatus = 'placed' | 'accepted' | 'ready' | 'completed' | 'cancelled' | 'rejected';

export interface Order {
  id: string;
  business: { id: string; handle: string; name: string };
  customer?: UserSummary | null;
  status: OrderStatus;
  statusReason: string;
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
  status: 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  cancelledBy: 'customer' | 'business' | null;
  note: string;
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
  placed: 'Waiting for the business',
  accepted: 'Being prepared',
  ready: 'Ready to collect',
  completed: 'Collected',
  cancelled: 'Cancelled',
  rejected: 'Declined',
};

/** What staff can move an order to next, with the button label. Mirrors the API's rules. */
export const NEXT_STEPS: Record<OrderStatus, { to: OrderStatus; label: string }[]> = {
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
