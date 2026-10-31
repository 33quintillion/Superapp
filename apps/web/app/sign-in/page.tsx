import Link from 'next/link';
import { emailSignupOpen, phoneConfig } from '@/lib/phone-config';
import { skipIfSignedIn } from '@/lib/signed-in';
import { signIn } from '../actions';
import { AuthPage, AuthShell } from '../auth-shell';
import styles from '../auth.module.css';
import { ActionForm } from '../form-ui';
import { SignInChoice } from '../sign-in-choice';

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
  await skipIfSignedIn(expired);
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
    <AuthPage>
      <SignInChoice
        phone={phone}
        notice={notice}
        footer={
          <details className={styles.email}>
            <summary>Signed up with email before? Sign in with email</summary>
            <EmailSignIn />
          </details>
        }
      />
    </AuthPage>
  );
}
