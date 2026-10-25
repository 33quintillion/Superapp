import { authed } from '@/lib/session';
import { resendVerification, revokeSession, signOut } from '../actions';

export const dynamic = 'force-dynamic';

interface Me {
  username: string;
  displayName: string;
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
  const [me, sessions] = await Promise.all([authed<Me>('GET', '/v1/me'), authed<Session[]>('GET', '/v1/sessions')]);
  return (
    <main className="wide">
      <h1 data-testid="display-name">{me.displayName}</h1>
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

      <form action={signOut} style={{ marginTop: 'var(--space-xl)' }}>
        <button className="btn quiet" type="submit">
          Sign out of this device
        </button>
      </form>
    </main>
  );
}
