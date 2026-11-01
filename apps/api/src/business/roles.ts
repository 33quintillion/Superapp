/**
 * Staff roles inside a business and what each may do. This table is the single source of
 * truth: every business endpoint names a permission and BusinessesService.requireStaff
 * checks it here, so the rules can be read (and tested) in one place.
 */
export type StaffRole = 'owner' | 'manager' | 'staff';

export const STAFF_ROLES: StaffRole[] = ['owner', 'manager', 'staff'];

const ALL: StaffRole[] = ['owner', 'manager', 'staff'];
const MANAGERS: StaffRole[] = ['owner', 'manager'];

export const PERMISSIONS = {
  'business.view': ALL,
  'business.edit': MANAGERS,
  'business.delete': ['owner'],
  'business.transfer': ['owner'],
  'staff.view': ALL,
  'staff.manage': MANAGERS,
  'catalogue.manage': MANAGERS,
  'services.manage': MANAGERS,
  'orders.view': ALL,
  'orders.manage': ALL,
  'bookings.view': ALL,
  'bookings.manage': ALL,
  'orders.refund': MANAGERS,
  'bookings.refund': MANAGERS,
  // Answering a customer's bank about a disputed payment.
  'disputes.respond': MANAGERS,
  'payments.view': MANAGERS,
  // The payout account and the plan are the owner's: they decide where money goes and what is paid for.
  'payments.manage': ['owner'],
  'billing.manage': ['owner'],
} satisfies Record<string, StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: StaffRole | null | undefined, permission: Permission): boolean {
  return !!role && (PERMISSIONS[permission] as StaffRole[]).includes(role);
}

const RANK: Record<StaffRole, number> = { owner: 3, manager: 2, staff: 1 };

/**
 * Who can give or take away a role: the owner manages managers and staff; a manager
 * manages staff only. Nobody changes their own role or anyone at or above their rank.
 */
export function canManageRole(actor: StaffRole, targetRole: StaffRole): boolean {
  return can(actor, 'staff.manage') && RANK[actor] > RANK[targetRole];
}

/** Every permission a role holds, for clients that show or hide controls. */
export function permissionsOf(role: StaffRole): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}
