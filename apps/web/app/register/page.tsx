import Link from 'next/link';
import { emailSignupOpen, phoneConfig } from '@/lib/phone-config';
import { skipIfSignedIn } from '@/lib/signed-in';
import { register } from '../actions';
import { AuthShell } from '../auth-shell';
import styles from '../auth.module.css';
import { ActionForm } from '../form-ui';
import { PhoneSignIn } from '../phone-sign-in';

export const dynamic = 'force-dynamic';

function EmailSignUp() {
  return (
    <ActionForm
      action={register}
      submit="Create account"
      pending="Creating…"
      fields={[
        { name: 'displayName', label: 'Display name', autoComplete: 'name' },
        { name: 'username', label: 'Username', autoComplete: 'username', hint: '3-30 letters, numbers or underscores' },
        { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
        { name: 'password', label: 'Password', type: 'password', autoComplete: 'new-password', hint: 'At least 10 characters' },
      ]}
    />
  );
}

export default async function RegisterPage() {
  await skipIfSignedIn();
  const phone = phoneConfig();
  const email = emailSignupOpen();
  if (!phone) {
    return (
      <AuthShell title="Create your account" lede={email ? undefined : 'Sign-up isn’t open yet.'}>
        {email && <EmailSignUp />}
        <p>
          Already have an account? <Link href="/sign-in">Sign in</Link>
        </p>
      </AuthShell>
    );
  }
  return (
    <AuthShell>
      <PhoneSignIn config={phone} />
      {email && (
        <details className={styles.email}>
          <summary>Prefer email? Create an account with email</summary>
          <EmailSignUp />
        </details>
      )}
    </AuthShell>
  );
}
