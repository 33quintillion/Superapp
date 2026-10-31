import Link from 'next/link';
import { emailSignupOpen, phoneConfig } from '@/lib/phone-config';
import { signIn } from '../actions';
import { AuthShell } from '../auth-shell';
import styles from '../auth.module.css';
import { ActionForm } from '../form-ui';
import { PhoneSignIn } from '../phone-sign-in';

export const dynamic = 'force-dynamic';

function EmailSignIn() {
  return (
    <>
      <ActionForm
        action={signIn}
        submit="Sign in with email"
        pending="Signing in…"
        fields={[
          { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
          { name: 'password', label: 'Password', type: 'password', autoComplete: 'current-password' },
        ]}
      />
      <p>
        <Link href="/forgot-password">Forgot your password?</Link>
        {emailSignupOpen() && (
          <>
            {' '}
            · <Link href="/register">Create an account with email</Link>
          </>
        )}
      </p>
    </>
  );
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  const { expired } = await searchParams;
  const phone = phoneConfig();
  const notice = expired ? 'Your session ended. Please sign in again.' : undefined;
  if (!phone) {
    return (
      <AuthShell title="Sign in" lede={notice}>
        <EmailSignIn />
      </AuthShell>
    );
  }
  return (
    <AuthShell>
      {notice && <p className="muted">{notice}</p>}
      <PhoneSignIn config={phone} />
      <details className={styles.email}>
        <summary>Signed up with email before? Sign in with email</summary>
        <EmailSignIn />
      </details>
    </AuthShell>
  );
}
