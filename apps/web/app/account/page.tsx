import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { authed, requireAccessToken } from '@/lib/session';
import { removeEmail, resendVerification, revokeSession, setEmail, signOut } from '../actions';
import { ActionForm } from '../form-ui';
import { SignOutForm } from './sign-out-button';
import { FindPeople } from './find-people';
import { NotificationSettings } from './notifications';
import { ProfilePhoto } from './profile-photo';
import { SocialSettings } from './social-settings';

export const dynamic = 'force-dynamic';

interface Me {
  username: string | null;
  displayName: string;
  avatarMediaId: string | null;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  mfaEnabled: boolean;
}
interface Session {
  id: string;
  deviceName: string;
  userAgent: string | null;
  lastUsedAt: string;
  current: boolean;
}

export default async function AccountPage() {
  const [me, sessions, staff] = await Promise.all([authed<Me>('GET', '/v1/me'), authed<Session[]>('GET', '/v1/sessions'), platformStaff()]);
  return (
    <main className="wide">
      <h1 data-testid="display-name">{me.displayName}</h1>
      <ProfilePhoto initial={me.avatarMediaId} name={me.displayName} />
      <div className="card">
        {me.phone && (
          <div className="row">
            <span>Phone</span>
            <span data-testid="phone">{me.phone}</span>
          </div>
        )}
        {me.username && (
          <div className="row">
            <span>Username</span>
            <span>@{me.username}</span>
          </div>
        )}
        <div className="row">
          <span>Email</span>
          <span data-testid="email">
            {me.email ? (
              <>
                {me.email} <span className="pill">{me.emailVerified ? 'Confirmed' : 'Not confirmed'}</span>
              </>
            ) : (
              <span className="muted">Not added</span>
            )}
          </span>
        </div>
        <div className="row">
          <span>Two-step verification</span>
          <span className="pill">{me.mfaEnabled ? 'On' : 'Off'}</span>
        </div>
      </div>
      {me.email && !me.emailVerified && (
        <form action={resendVerification} style={{ marginTop: 'var(--space-md)' }}>
          <button className="btn quiet" type="submit">
            Resend confirmation email
          </button>
        </form>
      )}

      {me.phone && (
        <>
          <h2>{me.email ? 'Change your email' : 'Add an email'}</h2>
          <p className="muted">For receipts and banking. You’ll need a confirmed email to receive payouts for a business. You sign in with your phone number either way.</p>
          <ActionForm
            action={setEmail}
            submit={me.email ? 'Change email' : 'Add email'}
            pending="Saving…"
            fields={[{ name: 'email', label: 'Email', type: 'email', autoComplete: 'email' }]}
            success={<p>Check your inbox for a link to confirm it.</p>}
          />
          {me.email && (
            <form action={removeEmail} style={{ marginTop: 'var(--space-sm)' }}>
              <button className="btn quiet" type="submit">
                Remove email
              </button>
            </form>
          )}
        </>
      )}

      {me.username && (
        <p>
          <a href={`/u/${me.username}`}>View your profile</a>
        </p>
      )}

      <h2>Privacy</h2>
      <SocialSettings />

      <h2>Find people you know</h2>
      <FindPeople />

      <h2>Notifications</h2>
      <NotificationSettings />

      {staff && (
        <>
          <h2>Platform staff</h2>
          <div className="card" data-testid="staff-access">
            {staff === 'ok' ? <Link href="/admin">Open the admin dashboard</Link> : <p className="muted">{staff}</p>}
          </div>
        </>
      )}

      <h2>Signed-in devices</h2>
      <div className="card" data-testid="sessions">
        {sessions.map((s) => (
          <div className="row" key={s.id}>
            <div>
              <div>
                {s.deviceName} {s.current && <span className="pill">This device</span>}
              </div>
              <small className="muted">Last active {new Date(s.lastUsedAt).toLocaleString('en')}</small>
            </div>
            {!s.current && (
              <form action={revokeSession}>
                <input type="hidden" name="id" value={s.id} />
                <button className="btn quiet" type="submit">
                  Sign out
                </button>
              </form>
            )}
          </div>
        ))}
      </div>

      <SignOutForm action={signOut} />
    </main>
  );
}

/** 'ok' for staff who can open the dashboard, the reason for staff who can't yet, null for everyone else. */
async function platformStaff(): Promise<string | null> {
  try {
    await api('GET', '/v1/admin/overview', { accessToken: await requireAccessToken() });
    return 'ok';
  } catch (e) {
    if (e instanceof ApiError && e.status === 403 && e.code !== 'not_platform_staff') return e.message;
    return null;
  }
}
