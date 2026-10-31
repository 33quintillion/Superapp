'use client';

import { clearOutboxes } from '@/lib/outbox-store';

/** Signing out also clears messages this browser was still waiting to send. */
export function SignOutForm({ action }: { action: () => Promise<void> }) {
  return (
    <form action={action} onSubmit={() => clearOutboxes()} style={{ marginTop: 'var(--space-xl)' }}>
      <button className="btn quiet" type="submit">
        Sign out of this device
      </button>
    </form>
  );
}
