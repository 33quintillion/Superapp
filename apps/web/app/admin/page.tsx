import { ApiError } from '@/lib/api';
import { authed } from '@/lib/session';
import { AdminApp, Overview } from './admin-app';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  try {
    const overview = await authed<Overview>('GET', '/v1/admin/overview');
    return <AdminApp overview={overview} />;
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 403) throw e;
    // Staff who still need two-step, or a fresh two-step sign-in, are told how to get in.
    return (
      <main className="stack">
        <h1>Admin</h1>
        <p data-testid="admin-refused" data-code={e.code}>
          {e.message}.
        </p>
        {e.code === 'mfa_reauth_required' && <p className="muted small">Sign out, then sign in again with your email, password and two-step code.</p>}
      </main>
    );
  }
}
