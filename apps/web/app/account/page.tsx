import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { authed, requireAccessToken } from '@/lib/session';
import { resendVerification, revokeSession, signOut } from '../actions';
import { SignOutForm } from './sign-out-button';
import { FindPeople } from './find-people';
import { NotificationSettings } from './notifications';
import { ProfilePhoto } from './profile-photo';
import { SocialSettings } from './social-settings';

export const dynamic = 'force-dynamic';

interface Me {
  username: string;
  displayName: string;
  avatarMediaId: string | null;
  email: string;
  emailVerified: boolean;
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
        <div className="row">
          <span>Username</span>
          <span>@{me.username}</span>
        </div>
        <div className="row">
          <span>Email</span>
          <span>
            {me.email} <span className="pill">{me.emailVerified ? 'Confirmed' : 'Not confirmed'}</span>
          </span>
        </div>
        <div className="row">
          <span>Two-step verification</span>
          <span className="pill">{me.mfaEnabled ? 'On' : 'Off'}</span>
        </div>
      </div>
      {!me.emailVerified && (
        <form action={resendVerification} style={{ marginTop: 'var(--space-md)' }}>
          <button className="btn quiet" type="submit">
            Resend confirmation email
          </button>
        </form>
      )}

      <p>
        <a href={`/u/${me.username}`}>View your profile</a>
      </p>

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
